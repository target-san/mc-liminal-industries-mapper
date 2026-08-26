/*
   In-page modal dialogs.

   window.prompt / confirm / alert are ignored outright inside a sandboxed
   iframe that lacks the allow-modals permission -- VS Code's Simple Browser
   being the case in point. There prompt() returns null and confirm() returns
   false, which every caller reads as "cancelled", so renaming and deleting
   silently did nothing and import errors vanished unreported.

   <dialog>.showModal() is not gated by that flag, and brings focus trapping,
   Esc-to-close and a backdrop with it. The trade is that it resolves through
   a promise instead of blocking the thread the way prompt() did, so callers
   are async.
*/

let root = null;
let titleEl, msgEl, inputEl, okBtn, cancelBtn;

function build() {
  root = document.createElement("dialog");
  root.className = "modal";

  /* method="dialog" makes the submit button close the dialog and hand its
     value to returnValue; Esc closes with an empty one, which reads as
     cancel. Cancel is a plain button so that Enter activates OK instead. */
  const form = document.createElement("form");
  form.method = "dialog";

  titleEl = document.createElement("h3");
  msgEl = document.createElement("p");

  inputEl = document.createElement("input");
  inputEl.type = "text";

  const buttons = document.createElement("div");
  buttons.className = "modal-buttons";

  cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", function () { root.close("cancel"); });

  okBtn = document.createElement("button");
  okBtn.type = "submit";
  okBtn.value = "ok";

  buttons.appendChild(cancelBtn);
  buttons.appendChild(okBtn);

  form.appendChild(titleEl);
  form.appendChild(msgEl);
  form.appendChild(inputEl);
  form.appendChild(buttons);
  root.appendChild(form);
  document.body.appendChild(root);
}

function open(opts) {
  if (!root) build();

  titleEl.textContent = opts.title;
  msgEl.textContent = opts.message || "";
  msgEl.style.display = opts.message ? "" : "none";
  inputEl.style.display = opts.input ? "" : "none";
  inputEl.value = opts.input ? (opts.value || "") : "";
  cancelBtn.style.display = opts.cancel === false ? "none" : "";
  okBtn.textContent = opts.okLabel || "OK";
  okBtn.className = "primary" + (opts.danger ? " danger" : "");

  return new Promise(function (resolve) {
    function onClose() {
      root.removeEventListener("close", onClose);
      const accepted = root.returnValue === "ok";
      resolve(opts.input ? (accepted ? inputEl.value : null) : accepted);
    }
    root.addEventListener("close", onClose);
    root.returnValue = "";
    root.showModal();
    if (opts.input) {
      inputEl.focus();
      inputEl.select();
    } else {
      okBtn.focus();
    }
  });
}

/* Resolves to the entered text, or null if cancelled. */
function askText(title, value, okLabel) {
  return open({ title: title, input: true, value: value, okLabel: okLabel || "OK" });
}

/* Resolves to true only on an explicit confirmation. */
function askConfirm(title, message, okLabel, danger) {
  return open({
    title: title, message: message,
    okLabel: okLabel || "OK", danger: danger === true,
  });
}

function showError(title, message) {
  return open({ title: title, message: message, cancel: false, okLabel: "Close" });
}

export {
  askText,
  askConfirm,
  showError,
};
