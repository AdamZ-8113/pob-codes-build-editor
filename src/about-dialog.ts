// Opens the static About dialog from index.html. The dialog content is fixed
// markup; this module only shows, closes, and restores focus.
export interface AboutDialogElements {
  trigger: HTMLElement;
  dialog: HTMLDialogElement;
}

export function bindAboutDialog({ trigger, dialog }: AboutDialogElements) {
  trigger.addEventListener("click", () => {
    if (!dialog.open) dialog.showModal();
  });
  // The dialog has no padding and its frame covers it, so a press and release
  // that both target the dialog element itself came from the backdrop. Text
  // selections dragged out of the frame do not close it.
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedBackdrop = event.target === dialog;
  });
  dialog.addEventListener("click", (event) => {
    if (pressedBackdrop && event.target === dialog) dialog.close();
    pressedBackdrop = false;
  });
  // Escape, the close button, and backdrop clicks all end here.
  dialog.addEventListener("close", () => trigger.focus());
}
