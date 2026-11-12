/** Data: collections (schema inspector) + record browser with typed forms. */
import { api, ApiError, type AttributeDef, type CollectionSchema, type RecordRow } from "../api";
import {
  badge,
  button,
  confirmDialog,
  el,
  emptyState,
  field,
  openModal,
  sectionCard,
  selectInput,
  checkboxInput,
  text,
  textInput,
  toast,
} from "../components";
import { appNav, pageHead, withLoading, type ViewContext } from "./helpers";

const SYSTEM_FIELDS = ["id", "org_id", "created_at", "updated_at", "created_by"];

function attributeRow(attr: AttributeDef, onRemove: () => void): { element: HTMLElement; read: () => AttributeDef } {
  const name = textInput({ placeholder: "field_name", value: attr.name });
  name.setAttribute("aria-label", "Field name");
  const type = selectInput(
    [
      { label: "string", value: "string" },
      { label: "number", value: "number" },
      { label: "boolean", value: "boolean" },
      { label: "datetime", value: "datetime" },
      { label: "json", value: "json" },
    ],
    { value: attr.type },
  );
  type.setAttribute("aria-label", "Field type");
  const req = checkboxInput("Required", attr.required);
  const remove = button("Remove", onRemove, "ghost");
  const element = el("div", { class: "row", style: "align-items: end" }, [
    field("Field", name),
    field("Type", type),
    req.wrap,
    remove,
  ]);
  return {
    element,
    read: () => ({ name: name.value.trim(), required: req.box.checked, type: type.value as AttributeDef["type"] }),
  };
}

export async function renderData(root: HTMLElement, ctx: ViewContext, appId: string): Promise<void> {
  await withLoading(root, async () => {
    const { app } = await api.getApp(appId);
    const { collections } = await api.getSchema(appId);
    let selectedName: string | null = collections[0]?.name ?? null;

    const collectionsBox = el("div", { class: "stack" });
    const recordsBox = el("div", { class: "stack" });

    const renderRecords = async (collection: CollectionSchema) => {
      recordsBox.replaceChildren(el("p", { class: "card-hint" }, [text("Loading records…")]));
      let rows: RecordRow[] = [];
      let total = 0;
      try {
        const res = await api.listRecords(appId, collection.name);
        rows = res.records;
        total = res.total;
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Could not load records.";
        const denied = err instanceof ApiError && err.status === 403;
        recordsBox.replaceChildren(
          el("div", { class: `callout${denied ? " callout-danger" : ""}` }, [
            el("p", {}, [text(denied ? `Profile Lock denied this read (${message}). Your profile has no read rule for “${collection.name}”. Ask an admin to update the profile, or edit it in the Security tab.` : message)]),
          ]),
        );
        return;
      }

      const columns = collection.attributes.map((a) => a.name);
      const table = el("table", { class: "data-table" });
      const thead = el("thead", {}, [
        el("tr", {}, [...columns.map((c) => el("th", {}, [text(c)])), el("th", {}, [text("Actions")])]),
      ]);
      const tbody = el("tbody");
      for (const row of rows) {
        const cells = columns.map((c) => {
          const value = row[c];
          return el("td", {}, [text(value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value))]);
        });
        const delBtn = button("Delete", async () => {
          const ok = await confirmDialog("Delete record?", `Delete record ${row.id}?`, "Delete", true);
          if (!ok) return;
          try {
            await api.deleteRecord(appId, collection.name, row.id);
            toast("Record deleted.", "success");
            await renderRecords(collection);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Delete failed.", "error");
          }
        }, "danger");
        tbody.append(el("tr", {}, [...cells, el("td", {}, [delBtn])]));
      }
      table.append(thead, tbody);

      const openAdd = () => {
        const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
        const formFields: HTMLElement[] = [];
        for (const attr of collection.attributes) {
          let control: HTMLInputElement | HTMLSelectElement;
          if (attr.type === "boolean") {
            control = selectInput([
              { label: "false", value: "false" },
              { label: "true", value: "true" },
            ]);
          } else {
            control = textInput({ placeholder: attr.type, type: attr.type === "number" ? "number" : attr.type === "datetime" ? "datetime-local" : "text" });
          }
          inputs.set(attr.name, control);
          formFields.push(field(`${attr.name}${attr.required ? " *" : ""}`, control));
        }
        const close = openModal(
          `New ${collection.name} record`,
          el("div", {}, formFields),
          [
            button("Cancel", () => close()),
            button(
              "Create record",
              async () => {
                const fields: Record<string, unknown> = {};
                for (const attr of collection.attributes) {
                  const raw = inputs.get(attr.name)?.value ?? "";
                  if (raw === "") continue;
                  if (attr.type === "number") fields[attr.name] = Number(raw);
                  else if (attr.type === "boolean") fields[attr.name] = raw === "true";
                  else if (attr.type === "json") {
                    try {
                      fields[attr.name] = JSON.parse(raw);
                    } catch {
                      toast(`Field ${attr.name} is not valid JSON.`, "error");
                      return;
                    }
                  } else fields[attr.name] = raw;
                }
                try {
                  await api.createRecord(appId, collection.name, fields);
                  close();
                  toast("Record created.", "success");
                  await renderRecords(collection);
                } catch (err) {
                  toast(err instanceof Error ? err.message : "Create failed.", "error");
                }
              },
              "primary",
            ),
          ],
        );
      };

      recordsBox.replaceChildren(
        sectionCard(
          `${collection.name} — ${total} record${total === 1 ? "" : "s"}`,
          rows.length === 0
            ? emptyState("No records", "Add the first record, or have your AI assistant create some over MCP.", button("Add record", openAdd, "primary"))
            : el("div", { class: "table-wrap" }, [table]),
          { hint: "Fields shown are limited by your profile's read whitelist." },
        ),
        el("div", { class: "row" }, [button("Add record", openAdd, "primary")]),
      );
    };

    const renderCollections = () => {
      collectionsBox.replaceChildren();
      if (collections.length === 0) {
        collectionsBox.append(emptyState("No collections", "Collections define your tables. Create one to start storing records."));
        return;
      }
      for (const c of collections) {
        const selected = c.name === selectedName;
        const card = el("div", { class: "card", style: selected ? "border-color: var(--color-accent)" : "" }, [
          el("div", { class: "row", style: "justify-content: space-between" }, [
            el("strong", {}, [text(c.name)]),
            badge(`${c.attributes.length} fields`, "neutral"),
          ]),
          el("p", { class: "card-hint mono" }, [text(c.attributes.map((a) => `${a.name}:${a.type}${a.required ? "*" : ""}`).join("  "))]),
          el("div", { class: "row" }, [
            button(selected ? "Viewing" : "View records", async () => {
              selectedName = c.name;
              renderCollections();
              await renderRecords(c);
            }, selected ? "primary" : "secondary"),
            button("Delete", async () => {
              const ok = await confirmDialog("Delete collection?", `Delete “${c.name}” and all its records?`, "Delete", true);
              if (!ok) return;
              try {
                await api.deleteCollection(appId, c.name);
                toast("Collection deleted.", "success");
                await renderData(root, ctx, appId);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Delete failed.", "error");
              }
            }, "danger"),
          ]),
        ]);
        collectionsBox.append(card);
      }
    };

    const openCreateCollection = () => {
      const name = textInput({ id: "new-collection-name", placeholder: "tasks" });
      const attrRows: Array<{ element: HTMLElement; read: () => AttributeDef }> = [];
      const attrBox = el("div", { class: "stack" });
      const addRow = (attr: AttributeDef) => {
        const row = attributeRow(attr, () => {
          const idx = attrRows.indexOf(row);
          if (idx >= 0) attrRows.splice(idx, 1);
          row.element.remove();
        });
        attrRows.push(row);
        attrBox.append(row.element);
      };
      addRow({ name: "title", required: true, type: "string" });
      const close = openModal(
        "New collection",
        el("div", {}, [
          field("Collection name", name, { hint: "Lowercase letters, numbers, underscores. System fields (id, org_id, created_at…) are automatic.", id: "new-collection-name" }),
          el("h3", {}, [text("Attributes")]),
          attrBox,
          button("Add attribute", () => addRow({ name: "", required: false, type: "string" })),
        ]),
        [
          button("Cancel", () => close()),
          button(
            "Create collection",
            async () => {
              const attributes = attrRows.map((r) => r.read()).filter((a) => a.name);
              if (!name.value.trim() || attributes.length === 0) {
                toast("Name the collection and add at least one attribute.", "error");
                return;
              }
              if (attributes.some((a) => SYSTEM_FIELDS.includes(a.name))) {
                toast("Attribute names must not collide with system fields.", "error");
                return;
              }
              try {
                await api.createCollection(appId, { attributes, name: name.value.trim() });
                close();
                toast("Collection created.", "success");
                await renderData(root, ctx, appId);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Create failed.", "error");
              }
            },
            "primary",
          ),
        ],
      );
    };

    renderCollections();
    const selected = collections.find((c) => c.name === selectedName);
    if (selected) await renderRecords(selected);
    else recordsBox.replaceChildren(emptyState("No collection selected", "Create a collection, then browse its records here."));

    root.replaceChildren(
      pageHead(app.name, "Data · Collections and records. Every query is scoped to your organization and filtered by your profile.", [
        button("New collection", openCreateCollection, "primary"),
      ]),
      appNav(appId, "data"),
      el("div", { class: "grid-2", style: "align-items: start" }, [
        el("div", { class: "stack" }, [el("h2", { class: "card-title" }, [text("Collections")]), collectionsBox]),
        recordsBox,
      ]),
    );
  });
}
