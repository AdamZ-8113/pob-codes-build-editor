import { assertEquals } from "@std/assert";
import { type PoBKey, PoBKeyboardState } from "../../src/js/keyboard.ts";
import { MouseHandler } from "../../src/js/mouse-handler.ts";

function setup() {
  const events: unknown[] = [];
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { defaultView: win, hidden: false });
  let focuses = 0;
  const el = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    focus: () => focuses++,
  });
  const keys = PoBKeyboardState.make({
    onKeyDown: (_state, key) => events.push(["down", key]),
    onKeyUp: (_state, key) => events.push(["up", key]),
    onChar: () => {},
  });
  const handler = new MouseHandler(el as unknown as HTMLElement, {
    onMouseStateUpdate: (pos) => events.push(["move", pos.x, pos.y, [...keys.pobKeys]]),
    onPan: (x, y) => events.push(["pan", x, y]),
  }, keys);
  const send = (type: string, buttons: number, button = 0, target = el as EventTarget, x = 110) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { buttons, button, clientX: x, clientY: 120 });
    target.dispatchEvent(event);
    return event;
  };
  return { events, win, doc, el, keys, handler, send, focuses: () => focuses };
}

Deno.test('quick touch delivers final position before click even before the multi-touch timer', async () => {
  const previous = globalThis.window;
  Object.assign(globalThis, {window:globalThis});
  const h = setup();
  const touch = {identifier:1,clientX:110,clientY:120};
  const event = (touches:unknown[],changed:unknown[]) => Object.assign(new Event('touch',{cancelable:true}),{touches,changedTouches:changed}) as unknown as TouchEvent;
  try {
    h.handler.handleTouchStart(event([touch],[touch]));
    h.events.length=0;
    h.handler.handleTouchEnd(event([],[{...touch,clientX:210,clientY:220}]));
    assertEquals(h.events.slice(0,2),[['move',200,200,[]],['down','LEFTBUTTON']]);
    await new Promise(resolve=>setTimeout(resolve,60));
    assertEquals(h.events,[['move',200,200,[]],['down','LEFTBUTTON'],['up','LEFTBUTTON']]);
  } finally {h.handler.destroy(); Object.assign(globalThis,{window:previous});}
});

Deno.test('cancelled quick touch cannot deliver delayed movement or clicks', async () => {
  const previous=globalThis.window;Object.assign(globalThis,{window:globalThis});const h=setup();
  const touch={identifier:1,clientX:110,clientY:120};
  const event=(touches:unknown[])=>Object.assign(new Event('touch',{cancelable:true}),{touches,changedTouches:[touch]}) as unknown as TouchEvent;
  try{
    h.handler.handleTouchStart(event([touch]));h.events.length=0;
    h.handler.handleTouchCancel(event([]));await new Promise(resolve=>setTimeout(resolve,60));
    assertEquals(h.events,[]);
  }finally{h.handler.destroy();Object.assign(globalThis,{window:previous});}
});

Deno.test("release outside the canvas forwards final position before releasing, without stealing focus", () => {
  const h = setup();
  h.send("mousedown", 1);
  h.events.length = 0;
  const event = h.send("mouseup", 0, 0, h.doc, 210);
  assertEquals(h.events, [["move", 200, 100, ["LEFTBUTTON"]], ["up", "LEFTBUTTON"]]);
  assertEquals([...h.keys.pobKeys], []);
  assertEquals(h.focuses(), 1);
  assertEquals(event.defaultPrevented, false);
  h.events.length = 0;
  h.send("mouseup", 0, 0, h.doc);
  assertEquals(h.events, [], "Unrelated shell releases must be ignored");
  h.handler.destroy();
});

for (
  const [button, mask, key] of [[0, 1, "LEFTBUTTON"], [1, 4, "MIDDLEBUTTON"], [2, 2, "RIGHTBUTTON"], [3, 8, "MOUSE4"], [
    4,
    16,
    "MOUSE5",
  ]] as const
) {
  Deno.test(`missed ${key} release recovers before unheld motion, using the correct buttons mask`, () => {
    const h = setup();
    h.send("mousedown", mask, button);
    h.events.length = 0;
    h.send("mousemove", mask, button);
    assertEquals(h.events, [["move", 100, 100, [key]]]);
    h.events.length = 0;
    h.send("mousemove", 0, button, h.el, 310);
    assertEquals(h.events, [["up", key], ["move", 300, 100, []]]);
    h.handler.destroy();
  });
}

Deno.test("window blur and hidden document release all owned buttons once", () => {
  for (const hide of [false, true]) {
    const h = setup();
    h.send("mousedown", 1);
    h.send("mousedown", 3, 2);
    h.keys.keydown("CTRL" as PoBKey, 0);
    h.events.length = 0;
    if (hide) {
      h.doc.hidden = true;
      h.doc.dispatchEvent(new Event("visibilitychange"));
    } else h.win.dispatchEvent(new Event("blur"));
    h.win.dispatchEvent(new Event("blur"));
    assertEquals(h.events, [["up", "LEFTBUTTON"], ["up", "RIGHTBUTTON"]]);
    assertEquals([...h.keys.pobKeys], ["CTRL"]);
    h.handler.destroy();
  }
});

Deno.test("mouse recovery does not release buttons owned by touch or virtual input", () => {
  const h = setup();
  h.keys.keydown("LEFTBUTTON" as PoBKey, 0);
  h.events.length = 0;
  h.send("mousemove", 0);
  h.win.dispatchEvent(new Event("blur"));
  assertEquals(h.events, [["move", 100, 100, ["LEFTBUTTON"]]]);
  h.handler.destroy();
});

Deno.test("pan mode stops after missed release or blur without synthesizing native clicks", () => {
  for (const blur of [false, true]) {
    const h = setup();
    h.handler.setPanMode(true);
    h.send("mousedown", 1);
    h.send("mousemove", 1, 0, h.el, 210);
    assertEquals(h.events.some((e) => Array.isArray(e) && e[0] === "pan"), true);
    h.events.length = 0;
    if (blur) h.win.dispatchEvent(new Event("blur"));
    h.send("mousemove", 0, 0, h.el, 310);
    assertEquals(h.events, [["move", 300, 100, []]]);
    h.handler.destroy();
  }
});

Deno.test("destroy releases held buttons and removes document/window listeners", () => {
  const h = setup();
  h.send("mousedown", 1);
  h.events.length = 0;
  h.handler.destroy();
  assertEquals(h.events, [["up", "LEFTBUTTON"]]);
  h.events.length = 0;
  h.send("mousedown", 1);
  h.send("mouseup", 0, 0, h.doc);
  h.win.dispatchEvent(new Event("blur"));
  h.doc.hidden = true;
  h.doc.dispatchEvent(new Event("visibilitychange"));
  assertEquals(h.events, []);
});
