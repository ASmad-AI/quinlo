/**
 * Studio: split-screen workspace — project files, code editor, sandboxed
 * live preview, click-to-select inspector. Previews serve the latest
 * DEPLOYMENT, so editing a file requires a staging deploy before the
 * preview reflects it; the UI makes that explicit with a combined
 * "Save + deploy to staging" action.
 */
import { api, ApiError, type FileEntry } from "../api";
import { BRANDING } from "../branding";
import {
  badge,
  button,
  confirmDialog,
  el,
  emptyState,
  field,
  formatBytes,
  openModal,
  spinner,
  text,
  textArea,
  textInput,
  toast,
} from "../components";
import { PreviewController, type SelectedElement } from "../preview";
import { appNav, pageHead, withLoading, type ViewContext } from "./helpers";

const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My app</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 640px; padding: 0 1rem; }
  h1 { font-size: 2rem; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; }
</style>
</head>
<body>
  <h1>Hello from the forge</h1>
  <div class="card">
    <p>Click <strong>Inspect</strong>, then click any element to see its details here. Edit its text and save it back to this file.</p>
  </div>
</body>
</html>
`;

export async function renderStudio(root: HTMLElement, ctx: ViewContext, appId: string): Promise<() => void> {
  let cleanup: (() => void) | undefined;
  await withLoading(root, async () => {
    const { app } = await api.getApp(appId);
    const { files: initialFiles } = await api.listFiles(appId);

    // ---- State ----
    let files: FileEntry[] = initialFiles;
    let currentPath: string | null = files.some((f) => f.path === "index.html") ? "index.html" : (files[0]?.path ?? null);
    let dirty = false;
    let pendingPreviewHtml: string | null = null;
    let selected: SelectedElement | null = null;
    let environment: "staging" | "production" = "staging";

    // ---- File pane ----
    const fileList = el("div", { class: "file-tree", role: "listbox", "aria-label": "Project files" });
    const renderFiles = () => {
      fileList.replaceChildren();
      if (files.length === 0) {
        fileList.append(emptyState("No files yet", "Create index.html to get started.", undefined));
        return;
      }
      for (const f of files) {
        const item = el("button", {
          class: `file-item${f.path === currentPath ? " file-item-active" : ""}`,
          role: "option",
          "aria-selected": f.path === currentPath ? "true" : "false",
          type: "button",
        }, [
          el("span", {}, [text(f.path)]),
          el("span", { class: "file-size" }, [text(formatBytes(f.size))]),
        ]);
        item.addEventListener("click", () => void openFile(f.path));
        fileList.append(item);
      }
    };

    // ---- Editor pane ----
    const editor = el("textarea", {
      class: "editor-area",
      "aria-label": "File editor",
      placeholder: "Select a file to edit…",
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    const editorTitle = el("h2", { class: "studio-pane-title" }, [text("Editor")]);
    const dirtyBadge = badge("Unsaved changes", "warning");
    dirtyBadge.style.display = "none";
    const saveBtn = button("Save file", () => void saveFile(), "primary");
    const setDirty = (value: boolean) => {
      dirty = value;
      dirtyBadge.style.display = value ? "" : "none";
      saveBtn.disabled = !currentPath || !value;
    };
    editor.addEventListener("input", () => setDirty(true));

    const openFile = async (path: string) => {
      if (dirty) {
        const ok = await confirmDialog("Discard unsaved changes?", `You have unsaved edits in ${currentPath ?? "the current file"}.`, "Discard");
        if (!ok) return;
      }
      currentPath = path;
      try {
        const { content } = await api.readFile(appId, path);
        editor.value = content;
        editorTitle.textContent = path;
        setDirty(false);
        renderFiles();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Could not read the file.", "error");
      }
    };

    const saveFile = async (): Promise<boolean> => {
      if (!currentPath) return false;
      try {
        await api.writeFile(appId, currentPath, editor.value);
        setDirty(false);
        const { files: fresh } = await api.listFiles(appId);
        files = fresh;
        renderFiles();
        toast(`Saved ${currentPath}.`, "success");
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : "Save failed.", "error");
        return false;
      }
    };

    const newFile = () => {
      const pathInput = textInput({ id: "new-file-path", placeholder: "index.html" });
      const close = openModal(
        "New file",
        el("div", {}, [
          field("Path", pathInput, { hint: "Relative to the project root. Use index.html for the preview entry point.", id: "new-file-path" }),
        ]),
        [
          button("Cancel", () => close()),
          button(
            "Create file",
            async () => {
              const path = pathInput.value.trim().replace(/^\//, "");
              if (!path) return;
              try {
                const content = path === "index.html" ? STARTER_HTML : "";
                await api.writeFile(appId, path, content);
                close();
                const { files: fresh } = await api.listFiles(appId);
                files = fresh;
                await openFile(path);
                toast(`Created ${path}.`, "success");
              } catch (err) {
                toast(err instanceof Error ? err.message : "Could not create the file.", "error");
              }
            },
            "primary",
          ),
        ],
      );
    };

    const deleteFile = async () => {
      if (!currentPath) return;
      const ok = await confirmDialog("Delete file?", `Delete ${currentPath}? This cannot be undone.`, "Delete", true);
      if (!ok) return;
      try {
        await api.deleteFile(appId, currentPath);
        currentPath = null;
        editor.value = "";
        editorTitle.textContent = "Editor";
        setDirty(false);
        const { files: fresh } = await api.listFiles(appId);
        files = fresh;
        renderFiles();
        toast("File deleted.", "success");
      } catch (err) {
        toast(err instanceof Error ? err.message : "Could not delete the file.", "error");
      }
    };

    // ---- Preview + inspector ----
    const iframe = el("iframe", {
      class: "preview-frame",
      sandbox: "allow-scripts",
      title: "Live preview (sandboxed)",
    }) as HTMLIFrameElement;
    const inspectorBox = el("div", { class: "inspector" });
    const renderInspector = () => {
      if (!selected) {
        inspectorBox.replaceChildren(
          el("p", { class: "inspector-empty" }, [text("Arm the inspector, then click an element in the preview to inspect it.")]),
        );
        return;
      }
      const sel = selected;
      const textEdit = textArea({ rows: 3, value: sel.text });
      const applyBtn = button("Apply in preview", () => {
        preview.applyTextEdit(sel.path, textEdit.value);
      });
      const copyBtn = button("Copy context for AI", async () => {
        const context = JSON.stringify({ classes: sel.classes, path: sel.path, rect: sel.rect, tag: sel.tag, text: sel.text }, null, 2);
        try {
          await navigator.clipboard.writeText(context);
          toast("Element context copied. Paste it into your AI assistant.", "success");
        } catch {
          toast("Clipboard unavailable — select and copy manually.", "error");
        }
      });
      const saveDocBtn = button(
        "Save preview edits to file",
        async () => {
          if (!pendingPreviewHtml) {
            toast("No preview edits yet. Apply a text edit first.", "info");
            return;
          }
          const target = currentPath ?? "index.html";
          const ok = await confirmDialog(
            "Overwrite file with preview document?",
            `This writes the preview's serialized DOM back to ${target}. Inspector markup is stripped by the browser serialization, but formatting may differ from the original file.`,
            "Save to file",
          );
          if (!ok) return;
          try {
            await api.writeFile(appId, target, pendingPreviewHtml);
            pendingPreviewHtml = null;
            toast(`Saved preview edits to ${target}. Deploy to staging to see them in preview.`, "success");
          } catch (err) {
            toast(err instanceof Error ? err.message : "Save failed.", "error");
          }
        },
        "primary",
      );
      inspectorBox.replaceChildren(
        el("div", {}, [
          el("h3", { class: "studio-pane-title" }, [text(`<${sel.tag}>`)]),
          el("p", { class: "inspector-path" }, [text(sel.path)]),
          el("dl", { class: "kv-list" }, [
            el("dt", {}, [text("Classes")]),
            el("dd", {}, [text(sel.classes.join(" ") || "—")]),
            el("dt", {}, [text("Size")]),
            el("dd", {}, [text(`${sel.rect.width} × ${sel.rect.height} px`)]),
            el("dt", {}, [text("Position")]),
            el("dd", {}, [text(`${sel.rect.left}, ${sel.rect.top}`)]),
          ]),
          field("Text content", textEdit),
          el("div", { class: "row" }, [applyBtn, copyBtn, saveDocBtn]),
          pendingPreviewHtml
            ? el("p", { class: "field-hint" }, [text("Preview edits are pending — save them to the file to keep them.")])
            : el("span"),
        ]),
      );
    };

    const preview = new PreviewController((event) => {
      if (event.type === "selected") {
        selected = event.selected;
        renderInspector();
      } else if (event.type === "document-changed") {
        pendingPreviewHtml = event.html;
        renderInspector();
      }
    });
    preview.attach(iframe);
    cleanup = () => preview.detach();

    const inspectBtn = button("Inspect: off", () => {
      if (preview.isArmed()) {
        preview.disarm();
        inspectBtn.textContent = "Inspect: off";
      } else {
        preview.arm();
        inspectBtn.textContent = "Inspect: on";
        toast("Inspector armed. Hover to highlight, click to select.", "info");
      }
    });
    const envLabel = el("span", { class: "badge badge-neutral" }, [text("staging")]);
    const loadPreview = () => {
      iframe.src = `/preview/${appId}/${environment}/`;
      envLabel.textContent = environment;
    };
    const deployBtn = button("Save + deploy to staging", async () => {
      deployBtn.disabled = true;
      try {
        if (dirty) {
          const saved = await saveFile();
          if (!saved) return;
        }
        await api.deploy(appId, "staging");
        toast("Deployed to staging.", "success");
        environment = "staging";
        loadPreview();
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Deploy failed.";
        toast(message, "error");
      } finally {
        deployBtn.disabled = false;
      }
    }, "primary");
    const envToggle = button("View production", () => {
      environment = environment === "staging" ? "production" : "staging";
      envToggle.textContent = environment === "staging" ? "View production" : "View staging";
      loadPreview();
    });
    const reloadBtn = button("Reload preview", () => preview.reload());

    // ---- Assemble ----
    const filesPane = el("section", { class: "studio-pane" }, [
      el("div", { class: "studio-pane-head" }, [
        el("h2", { class: "studio-pane-title" }, [text("Files")]),
        el("div", { class: "row" }, [
          button("+ New", newFile),
          button("Delete", () => void deleteFile(), "danger"),
        ]),
      ]),
      fileList,
    ]);
    const editorPane = el("section", { class: "studio-pane" }, [
      el("div", { class: "studio-pane-head" }, [
        el("div", { class: "row" }, [editorTitle, dirtyBadge]),
        saveBtn,
      ]),
      editor,
    ]);
    const previewPane = el("section", { class: "studio-pane studio-pane-preview" }, [
      el("div", { class: "preview-toolbar" }, [
        el("h2", { class: "studio-pane-title" }, [text("Preview")]),
        envLabel,
        deployBtn,
        inspectBtn,
        envToggle,
        reloadBtn,
      ]),
      iframe,
      inspectorBox,
    ]);

    renderFiles();
    renderInspector();
    if (currentPath) {
      editorTitle.textContent = currentPath;
      editor.value = "";
      editor.placeholder = "Loading…";
      try {
        const { content } = await api.readFile(appId, currentPath);
        editor.value = content;
      } catch {
        editor.value = "";
      }
      editor.placeholder = "Select a file to edit…";
    }
    loadPreview();

    root.replaceChildren(
      pageHead(app.name, `Studio · ${app.slug} · Previews serve the latest deployment. Save, then deploy to staging to refresh the preview.`),
      appNav(appId, "studio"),
      el("div", { class: "callout", style: "margin-bottom: 1rem" }, [
        el("p", {}, [
          text("Preview is sandboxed: it cannot call the record API or reach cookies. For live data, deploy and use an API key from the "),
          el("a", { href: `#/apps/${appId}/security` }, [text("Security tab")]),
          text(". Build with AI over MCP: "),
          el("code", { class: "mono" }, [text(`${window.location.origin}${BRANDING.mcpPath}`)]),
          text("."),
        ]),
      ]),
      el("div", { class: "studio-layout" }, [filesPane, editorPane, previewPane]),
    );
  });
  return () => cleanup?.();
}

export function renderStudioLoading(root: HTMLElement): void {
  root.replaceChildren(spinner("Loading Studio…"));
}
