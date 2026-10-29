"""Generate a candidate source ledger from reviewed, explicit layer snapshots.

Snapshots are UTF-8 JSON maps of repository-relative paths to text (null for
absence). Inputs are authoring artifacts, never edited prepared runtime trees.
This writes only a new output directory and Git objects, not the checkout/index.
Normal source-ledger validation and pack remain independent acceptance gates.
"""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def blob(text):
    if text is None:
        return None
    data = text.encode("utf-8")
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def diff(before, after):
    result = ""
    for path in sorted(set(before) | set(after)):
        a, b = before.get(path), after.get(path)
        if a == b:
            continue
        result += f"diff --git a/{path} b/{path}\n"
        if a is None:
            result += "new file mode 100644\n"
        if b is None:
            raise ValueError("Source refresh must explicitly review file removal: " + path)
        result += f"index {blob(a) or '0' * 40}..{blob(b)}" + (" 100644" if a is not None else "") + "\n"
        for line in difflib.unified_diff((a or "").splitlines(True), b.splitlines(True), fromfile=f"a/{path}" if a is not None else "/dev/null", tofile=f"b/{path}", n=12):
            result += line if line.endswith("\n") else line + "\n\\ No newline at end of file\n"
    return result


def generate(args):
    pin = json.loads(Path(args.pin).read_text(encoding="utf-8"))
    layers = [json.loads(Path(path).read_text(encoding="utf-8")) for path in [args.pr_layer, args.relevance_layer, args.final_layer]]
    paths = set(layers[0])
    assert paths and all(set(layer) == paths for layer in layers), "Complete, identical layer inventories required"
    assert all(path.startswith(("src/", "spec/")) and ".." not in Path(path).parts and "\\" not in path for path in paths), "Invalid layer path"
    assert all(value is None or isinstance(value, str) and "\r" not in value for layer in layers for value in layer.values()), "UTF-8 LF source snapshots required"
    output = Path(args.out).resolve()
    assert not output.exists(), "Use a fresh candidate output directory"
    for entry in [pin["compositePatch"], *[o for o in pin["overlays"] if o.get("applicationStage") == "source-composite"]]:
        assert entry["patchFile"].startswith("patches/") and "\\" not in entry["patchFile"] and (output / entry["patchFile"]).resolve().is_relative_to(output), "Patch output must stay inside candidate directory"
    def git(*command, **kwargs):
        return subprocess.check_output(["git", "-c", "core.autocrlf=false", *command], cwd=args.checkout, **kwargs)
    assert git("rev-parse", "HEAD").decode().strip() == pin["revision"], "Checkout must be at the exact selected target"
    base = {}
    for path in sorted(paths):
        exists = subprocess.run(["git", "cat-file", "-e", f"HEAD:{path}"], cwd=args.checkout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        base[path] = git("show", f"HEAD:{path}").decode("utf-8") if exists else None
    output.mkdir(parents=True)
    local = [overlay for overlay in pin["overlays"] if overlay.get("applicationStage") == "source-composite"]
    assert [overlay["id"] for overlay in local] == ["power-report-relevance-pruning", "power-report-environment-reuse"], "Required layer order"
    for overlay, before, after in zip(local, layers, layers[1:]):
        changed = sorted(path for path in paths if before[path] != after[path])
        assert changed, "A required optimization layer became empty"
        patch = diff(before, after)
        target = output / overlay["patchFile"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(patch, encoding="utf-8", newline="\n")
        overlay.update(files=changed, sourceBlobHashes={p: blob(before[p]) for p in changed}, resultBlobHashes={p: blob(after[p]) for p in changed}, patchSha256=hashlib.sha256(target.read_bytes()).hexdigest())
    composite = pin["compositePatch"]
    patch_path = output / composite["patchFile"]
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_text(diff(base, layers[-1]), encoding="utf-8", newline="\n")
    # Git independently checks every hunk and computes the full resulting tree.
    # A private alternate index cannot stage changes in the author's checkout.
    with tempfile.TemporaryDirectory(prefix="pob-source-index-") as directory:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(directory) / "index")}
        git("read-tree", pin["revision"], env=env)
        git("apply", "--cached", "--check", str(patch_path), env=env)
        git("apply", "--cached", str(patch_path), env=env)
        tree = git("write-tree", env=env).decode().strip()
    changed = sorted(path for path in paths if base[path] != layers[-1][path])
    composite.update(baseRevision=pin["revision"], files=changed, resultBlobHashes={p: blob(layers[-1][p]) for p in changed}, patchSha256=hashlib.sha256(patch_path.read_bytes()).hexdigest(), resultTree=tree)
    (output / "source-pin.json").write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"revision": pin["revision"], "files": len(changed), "tree": tree, "patchSha256": composite["patchSha256"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["pin", "checkout", "pr-layer", "relevance-layer", "final-layer", "out"]:
        parser.add_argument("--" + name, required=True)
    generate(parser.parse_args())
