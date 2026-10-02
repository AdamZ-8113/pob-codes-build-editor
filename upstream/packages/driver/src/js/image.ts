import * as zstd from "@bokuweb/zstd-wasm";
import { Format, parseDDSDX10, Target, Texture } from "dds";
import { decodeBc7Texture } from "./bc7.ts";
import { log, tag } from "./logger.ts";

export type TextureSource =
  & {
    flags: number;
    target: Target;
    format: Format;
    width: number;
    height: number;
    layers: number;
    levels: number;
  }
  & (
    | {
      type: "Image";
      texture: (ImageBitmap | OffscreenCanvas | ImageData)[];
    }
    | {
      type: "Texture";
      texture: Texture;
    }
  );

export type TextureBitmap = {
  readonly id: string;
  readonly source: TextureSource;
  readonly updateSubImage?: () => {
    x: number;
    y: number;
    width: number;
    height: number;
    source: ArrayBufferView<ArrayBuffer>;
  };
};

export namespace TextureSource {
  export function newImage(texture: ImageBitmap | OffscreenCanvas | ImageData, flags: number): TextureSource {
    return {
      flags,
      target: Target.TARGET_2D_ARRAY,
      format: Format.RGBA8_UNORM_PACK8,
      width: texture.width,
      height: texture.height,
      layers: 1,
      levels: 1,
      type: "Image",
      texture: [texture],
    };
  }

  export function newTexture(texture: Texture, flags: number): TextureSource {
    return {
      flags,
      target: texture.target,
      format: texture.format,
      width: texture.extent[0],
      height: texture.extent[1],
      layers: texture.layers,
      levels: texture.levels,
      type: "Texture",
      texture,
    };
  }
}

type TextureHolder = {
  flags: number;
  textureSource: TextureSource | undefined;
  textureBitmap: TextureBitmap | undefined;
};

export enum TextureFlags {
  TF_CLAMP = 1,
  TF_NOMIPMAP = 2,
  TF_NEAREST = 4,
}

let zstdInitialized = false;

export class ImageRepository {
  private readonly prefix: string;
  private images: Map<number, TextureHolder> = new Map();
  private readonly resources = new Map<string, TextureHolder>();
  private readonly profile = { cacheHits: 0, completed: 0, failed: 0, zstdMs: 0, zstdMaxMs: 0,
    bc7Ms: 0, bc7MaxMs: 0, mipMs: 0, mipMaxMs: 0 };

  getProfile() { return { ...this.profile, resources: this.resources.size, handles: this.images.size }; }
  get generation() { return this.profile.completed + this.profile.failed; }
  private resolveBptcSupport: ((supported: boolean) => void) | undefined;
  private readonly bptcSupport = new Promise<boolean>((resolve) => {
    this.resolveBptcSupport = resolve;
  });

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  setBptcSupport(supported: boolean) {
    this.resolveBptcSupport?.(supported);
    this.resolveBptcSupport = undefined;
  }

  // Only a new resource returns a completion to observe. In particular, an
  // async no-op here would resolve every frame and perpetually request redraws.
  load(handle: number, src: string, flags: number): Promise<boolean> | undefined {
    const key = JSON.stringify([src, flags]);
    const cached = this.resources.get(key);
    if (cached) {
      this.profile.cacheHits++;
      this.images.set(handle, cached);
      return undefined;
    }
    const holder: TextureHolder = {
      flags,
      textureSource: undefined,
      textureBitmap: undefined,
    };
    // Publish before starting the fetch so concurrent aliases share in-flight
    // work too. Native handles are interned by this same source/flags identity.
    this.resources.set(key, holder);
    this.images.set(handle, holder);
    return this.loadResource(holder, src, flags, `image:${key}`).then((success) => {
      this.profile[success ? "completed" : "failed"]++;
      return success;
    }, (error) => { this.profile.failed++; throw error; });
  }

  private async loadResource(holder: TextureHolder, src: string, flags: number, id: string): Promise<boolean> {
    const type = src.endsWith(".dds.zst") ? "Texture" : "Image";
    const r = await fetch(this.prefix + src, { referrerPolicy: "no-referrer" });
    if (r.ok) {
      const blob = await r.blob();
      if (type === "Texture") {
        if (!zstdInitialized) {
          await zstd.init();
          zstdInitialized = true;
        }
        const compressed = new Uint8Array(await blob.arrayBuffer());
        const zstdStart = performance.now();
        const data = zstd.decompress(compressed);
        const zstdMs = performance.now() - zstdStart;
        this.profile.zstdMs += zstdMs;
        this.profile.zstdMaxMs = Math.max(this.profile.zstdMaxMs, zstdMs);
        try {
          let texture0 = parseDDSDX10(data);
          if (texture0.format === Format.RGBA_BP_UNORM_BLOCK16 && !await this.bptcSupport) {
            const bc7Start = performance.now();
            texture0 = await decodeBc7Texture(texture0);
            const bc7Ms = performance.now() - bc7Start;
            this.profile.bc7Ms += bc7Ms;
            this.profile.bc7MaxMs = Math.max(this.profile.bc7MaxMs, bc7Ms);
          }
          const texture = new Texture(
            Target.TARGET_2D_ARRAY,
            texture0.format,
            texture0.extent,
            texture0.layers,
            texture0.faces,
            texture0.levels,
          );
          texture.data = texture0.data;
          holder.textureSource = TextureSource.newTexture(texture, flags);
        } catch (e) {
          log.warn(tag.texture, `Failed to load DDS: src=${src}`, e);
        }
      } else {
        let image: ImageBitmap;
        try {
          image = await createImageBitmap(blob);
        } catch (error) {
          log.warn(tag.texture, `Failed to load image: src=${src}`, error);
          return false;
        }
        if (flags & TextureFlags.TF_NOMIPMAP) {
          holder.textureSource = TextureSource.newImage(image, flags);
        } else {
          const mipStart = performance.now();
          const { levels, mipmaps } = generateMipMap(image);
          const mipMs = performance.now() - mipStart;
          this.profile.mipMs += mipMs;
          this.profile.mipMaxMs = Math.max(this.profile.mipMaxMs, mipMs);
          holder.textureSource = {
            flags,
            target: Target.TARGET_2D_ARRAY,
            format: Format.RGBA8_UNORM_PACK8,
            width: image.width,
            height: image.height,
            layers: 1,
            levels,
            type: "Image",
            texture: mipmaps,
          };
        }
      }
      if (holder.textureSource) {
        // All aliases must also share the GPU texture, not just decoded pixels.
        holder.textureBitmap = { id, source: holder.textureSource };
      }
    }
    return holder.textureBitmap !== undefined;
  }

  get(handle: number): TextureBitmap | undefined {
    return this.images.get(handle)?.textureBitmap;
  }
}

function generateMipMap(image: ImageBitmap) {
  const levels = Math.floor(Math.log2(Math.max(image.width, image.height))) + 1;

  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Failed to get 2D context");

  let width = image.width;
  let height = image.height;
  const mipmaps: ImageData[] = [];

  for (let i = 0; i < levels; i++) {
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, image.width, image.height, 0, 0, width, height);
    const next = context.getImageData(0, 0, width, height);
    mipmaps.push(next);
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }

  return {
    levels,
    mipmaps,
  };
}
