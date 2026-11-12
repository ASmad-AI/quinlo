/** Functions & Ops: edge functions, billing, webhooks, deploy, audit log. */
import { api, ApiError, type BillingPlan } from "../api";
import { BRANDING } from "../branding";
import {
  badge,
  button,
  codeBlock,
  confirmDialog,
  el,
  emptyState,
  field,
  formatDate,
  openModal,
  sectionCard,
  selectInput,
  checkboxInput,
  tabs,
  text,
  textArea,
  textInput,
  toast,
} from "../components";
import { appNav, pageHead, withLoading, type ViewContext } from "./helpers";

const SAMPLE_FUNCTION = `// Runs in a sandbox: only input, console, JSON, Math, Date.
// Return a value (or a Promise). No require, fetch, or timers.
console.log("input:", JSON.stringify(input));
const name = input.name || "world";
return { greeting: "Hello, " + name + "!" };
`;

const WEBHOOK_EVENTS = ["on_user_signup", "on_record_created", "on_payment_succeeded"];

async function renderFunctionsTab(box: HTMLElement, appId: string): Promise<void> {
  const { functions } = await api.listFunctions(appId);
  const rows = functions.map((fn) =>
    el("tr", {}, [
      el("td", { class: "mono" }, [text(fn.name)]),
      el("td", {}, [text(formatDate(fn.updated_at))]),
      el("td", {}, [
        el("div", { class: "row" }, [
          button("Invoke", () => openInvoke(appId, fn.name)),
          button("Delete", async () => {
            const ok = await confirmDialog("Delete function?", `Delete “${fn.name}”?`, "Delete", true);
            if (!ok) return;
            try {
              await api.deleteFunction(appId, fn.name);
              toast("Function deleted.", "success");
              await renderFunctionsTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Delete failed.", "error");
            }
          }, "danger"),
        ]),
      ]),
    ]),
  );
  const table = el("table", { class: "data-table" });
  table.append(
    el("thead", {}, [el("tr", {}, ["Name", "Updated", ""].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, rows),
  );

  const openCreate = () => {
    const name = textInput({ id: "fn-name", placeholder: "greet" });
    const code = textArea({ rows: 12, value: SAMPLE_FUNCTION });
    code.setAttribute("aria-label", "Function code");
    const close = openModal(
      "New edge function",
      el("div", {}, [
        field("Name", name, { id: "fn-name" }),
        field("Code", code, { hint: "Sandboxed: no network, filesystem, or host access. 5s timeout." }),
      ]),
      [
        button("Cancel", () => close()),
        button(
          "Save function",
          async () => {
            try {
              await api.createFunction(appId, { code: code.value, name: name.value.trim() });
              close();
              toast("Function saved.", "success");
              await renderFunctionsTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Save failed.", "error");
            }
          },
          "primary",
        ),
      ],
    );
  };

  box.replaceChildren(
    sectionCard(
      "Edge functions",
      functions.length === 0
        ? emptyState("No functions yet", "Functions run sandboxed on the server. Create one to add custom logic your AI assistant can call over MCP.", button("New function", openCreate, "primary"))
        : el("div", { class: "table-wrap" }, [table]),
      { hint: "Code is write-only through the API: keep a copy in your project files or GitHub repo." },
    ),
    el("div", { class: "row" }, [button("New function", openCreate, "primary")]),
  );
}

function openInvoke(appId: string, name: string): void {
  const input = textArea({ rows: 5, value: '{\n  "name": "forge"\n}' });
  const output = el("div");
  const close = openModal(
    `Invoke ${name}`,
    el("div", {}, [field("Input (JSON)", input), output]),
    [
      button("Close", () => close()),
      button(
        "Run",
        async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(input.value);
          } catch {
            toast("Input is not valid JSON.", "error");
            return;
          }
          output.replaceChildren(el("p", { class: "card-hint" }, [text("Running…")]));
          try {
            const result = await api.invokeFunction(appId, name, parsed);
            output.replaceChildren(
              el("h3", {}, [text("Output")]),
              codeBlock(JSON.stringify(result.output, null, 2)),
              result.logs.length > 0 ? el("div", {}, [el("h3", {}, [text("Logs")]), codeBlock(result.logs.join("\n"))]) : el("span"),
            );
          } catch (err) {
            output.replaceChildren(el("div", { class: "callout callout-danger" }, [el("p", {}, [text(err instanceof Error ? err.message : "Invoke failed.")])]));
          }
        },
        "primary",
      ),
    ],
  );
}

async function renderBillingTab(box: HTMLElement, appId: string): Promise<void> {
  const [{ plans }, { subscriptions }, { totals }] = await Promise.all([
    api.listPlans(appId),
    api.listSubscriptions(appId),
    api.usageSummary(appId),
  ]);
  const planRows = plans.map((p: BillingPlan) =>
    el("tr", {}, [
      el("td", {}, [text(p.name)]),
      el("td", {}, [text(`${(p.price_cents / 100).toFixed(2)} ${p.currency.toUpperCase()}`)]),
      el("td", {}, [text(p.interval)]),
      el("td", {}, [badge(p.mode, p.mode === "live" ? "warning" : "info")]),
      el("td", { class: "mono" }, [text(p.stripe_price_id ?? "not synced to Stripe")]),
    ]),
  );
  const planTable = el("table", { class: "data-table" });
  planTable.append(
    el("thead", {}, [el("tr", {}, ["Plan", "Price", "Interval", "Mode", "Stripe price"].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, planRows),
  );

  const openCreate = () => {
    const name = textInput({ id: "plan-name", placeholder: "Pro" });
    const price = textInput({ id: "plan-price", placeholder: "999", type: "number" });
    const interval = selectInput([
      { label: "Monthly", value: "month" },
      { label: "Yearly", value: "year" },
    ]);
    const close = openModal(
      "Set billing plans",
      el("div", {}, [
        field("Plan name", name, { id: "plan-name" }),
        field("Price (cents)", price, { hint: "999 = $9.99.", id: "plan-price" }),
        field("Interval", interval),
        el("p", { class: "field-hint" }, [text("Plans are stored locally first. With a Stripe secret key in the vault they sync to Stripe; without one, checkout refuses honestly rather than faking a payment.")]),
      ]),
      [
        button("Cancel", () => close()),
        button(
          "Save plans",
          async () => {
            try {
              await api.createPlans(appId, [{ interval: interval.value as "month" | "year", name: name.value.trim(), price_cents: Number(price.value) }]);
              close();
              toast("Plans saved.", "success");
              await renderBillingTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Save failed.", "error");
            }
          },
          "primary",
        ),
      ],
    );
  };

  box.replaceChildren(
    sectionCard(
      "Billing plans",
      plans.length === 0
        ? emptyState("No plans yet", "Define pricing for this app. Zero markup: your Stripe account, your prices.", button("Set plans", openCreate, "primary"))
        : el("div", { class: "table-wrap" }, [planTable]),
      { hint: "Stripe webhook endpoint for this app: /api/v1/webhooks/stripe/" + appId },
    ),
    el("div", { class: "row" }, [button("Set plans", openCreate, "primary")]),
    sectionCard("Subscriptions", subscriptions.length === 0 ? el("p", { class: "card-hint" }, [text("No subscriptions yet.")]) : codeBlock(JSON.stringify(subscriptions, null, 2))),
    sectionCard("Usage totals", codeBlock(JSON.stringify(totals, null, 2))),
  );
}

async function renderWebhooksTab(box: HTMLElement, appId: string): Promise<void> {
  const { webhooks } = await api.listWebhooks(appId);
  const cards: HTMLElement[] = [];
  for (const hook of webhooks) {
    const deliveriesBox = el("div");
    const loadDeliveries = async () => {
      try {
        const { deliveries } = await api.listDeliveries(appId, hook.id);
        if (deliveries.length === 0) {
          deliveriesBox.replaceChildren(el("p", { class: "card-hint" }, [text("No deliveries yet.")]));
          return;
        }
        const rows = deliveries.slice(0, 10).map((d) =>
          el("tr", {}, [
            el("td", { class: "mono" }, [text(d.event)]),
            el("td", {}, [badge(d.status, d.status === "delivered" ? "success" : d.status === "failed" ? "danger" : "warning")]),
            el("td", {}, [text(String(d.attempts))]),
            el("td", {}, [text(d.last_error ?? "—")]),
            el("td", {}, [text(formatDate(d.created_at))]),
          ]),
        );
        const table = el("table", { class: "data-table" });
        table.append(
          el("thead", {}, [el("tr", {}, ["Event", "Status", "Attempts", "Last error", "Created"].map((h) => el("th", {}, [text(h)])))]),
          el("tbody", {}, rows),
        );
        deliveriesBox.replaceChildren(el("div", { class: "table-wrap" }, [table]));
      } catch (err) {
        deliveriesBox.replaceChildren(el("p", { class: "card-hint" }, [text(err instanceof Error ? err.message : "Could not load deliveries.")]));
      }
    };
    void loadDeliveries();
    cards.push(
      el("div", { class: "card" }, [
        el("div", { class: "row", style: "justify-content: space-between" }, [
          el("code", { class: "mono" }, [text(hook.url)]),
          badge(`secret ${hook.secret}`, "neutral"),
        ]),
        el("p", { class: "card-hint" }, [text(`Events: ${hook.events.join(", ")}`)]),
        el("div", { class: "row" }, [
          button("Send test", async () => {
            try {
              await api.testWebhook(appId, hook.id, hook.events[0] ?? "on_user_signup");
              toast("Test event sent.", "success");
              await loadDeliveries();
            } catch (err) {
              toast(err instanceof Error ? err.message : "Test failed.", "error");
            }
          }),
          button("Refresh deliveries", () => void loadDeliveries()),
          button("Delete", async () => {
            const ok = await confirmDialog("Delete webhook?", `Delete the endpoint ${hook.url}?`, "Delete", true);
            if (!ok) return;
            try {
              await api.deleteWebhook(appId, hook.id);
              toast("Webhook deleted.", "success");
              await renderWebhooksTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Delete failed.", "error");
            }
          }, "danger"),
        ]),
        deliveriesBox,
      ]),
    );
  }

  const openCreate = () => {
    const url = textInput({ id: "hook-url", placeholder: "https://hooks.example.com/receive", type: "url" });
    const boxes = WEBHOOK_EVENTS.map((e) => checkboxInput(e, true));
    const close = openModal(
      "New webhook endpoint",
      el("div", {}, [
        field("Endpoint URL", url, { hint: "Payloads are signed (X-Forge-Signature: sha256=<hmac>) and retried 5 times with backoff.", id: "hook-url" }),
        el("div", { class: "field" }, [el("span", { class: "field-label" }, [text("Events")]), ...boxes.map((b) => b.wrap)]),
      ]),
      [
        button("Cancel", () => close()),
        button(
          "Create endpoint",
          async () => {
            try {
              await api.createWebhook(appId, { events: WEBHOOK_EVENTS.filter((_e, i) => boxes[i].box.checked), url: url.value.trim() });
              close();
              toast("Webhook created.", "success");
              await renderWebhooksTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Create failed.", "error");
            }
          },
          "primary",
        ),
      ],
    );
  };

  box.replaceChildren(
    sectionCard(
      "Outbound webhooks",
      webhooks.length === 0
        ? emptyState("No endpoints", "Send signed events to Zapier, Make, n8n, or your own receiver.", button("New endpoint", openCreate, "primary"))
        : el("div", { class: "stack" }, cards),
      { hint: "Envelope: { event, app_id, app_slug, org_id, timestamp, data }. Retries at 1s / 5s / 15s / 60s / 300s." },
    ),
    el("div", { class: "row" }, [button("New endpoint", openCreate, "primary")]),
  );
}

async function renderDeployTab(box: HTMLElement, appId: string): Promise<void> {
  const [{ deployments }, { domains }, caddyfile, { link }] = await Promise.all([
    api.listDeployments(appId),
    api.listDomains(appId),
    api.getCaddyfile(appId),
    api.getGithubLink(appId),
  ]);

  const depRows = deployments.map((d) =>
    el("tr", {}, [
      el("td", { class: "mono" }, [text(d.id.slice(0, 18))]),
      el("td", {}, [badge(d.environment, d.environment === "production" ? "accent" : "info")]),
      el("td", {}, [badge(d.status, d.status === "live" ? "success" : "neutral")]),
      el("td", {}, [text(String(d.files))]),
      el("td", {}, [text(formatDate(d.created_at))]),
      el("td", {}, [
        el("a", { class: "btn btn-secondary btn-sm", href: `/preview/${appId}/${d.environment}/`, target: "_blank", rel: "noopener" }, [text("Open")]),
      ]),
    ]),
  );
  const depTable = el("table", { class: "data-table" });
  depTable.append(
    el("thead", {}, [el("tr", {}, ["Deployment", "Environment", "Status", "Files", "Created", ""].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, depRows),
  );

  const deployBtns = el("div", { class: "row" }, [
    button("Deploy to staging", async () => {
      try {
        await api.deploy(appId, "staging");
        toast("Deployed to staging.", "success");
        await renderDeployTab(box, appId);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Deploy failed.", "error");
      }
    }, "primary"),
    button("Promote staging → production", async () => {
      try {
        await api.promote(appId);
        toast("Promoted to production.", "success");
        await renderDeployTab(box, appId);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Promotion failed. Production requires a profile with access rules — check the Security tab.", "error");
      }
    }),
  ]);

  // Domains
  const domainRows = domains.map((d) =>
    el("tr", {}, [
      el("td", { class: "mono" }, [text(d.hostname)]),
      el("td", {}, [text(d.environment)]),
      el("td", {}, [badge(d.status, "neutral")]),
      el("td", {}, [
        button("Remove", async () => {
          const ok = await confirmDialog("Remove domain?", `Remove ${d.hostname}?`, "Remove", true);
          if (!ok) return;
          try {
            await api.deleteDomain(appId, d.id);
            toast("Domain removed.", "success");
            await renderDeployTab(box, appId);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Remove failed.", "error");
          }
        }, "danger"),
      ]),
    ]),
  );
  const domainTable = el("table", { class: "data-table" });
  domainTable.append(
    el("thead", {}, [el("tr", {}, ["Hostname", "Environment", "Status", ""].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, domainRows),
  );
  const hostname = textInput({ placeholder: "app.example.com" });
  const envSel = selectInput([
    { label: "production", value: "production" },
    { label: "staging", value: "staging" },
  ]);
  const addDomainBtn = button("Add domain", async () => {
    if (!hostname.value.trim()) return;
    try {
      await api.addDomain(appId, hostname.value.trim(), envSel.value as "staging" | "production");
      toast("Domain added. Point its DNS at this server; Caddy provisions SSL automatically.", "success");
      await renderDeployTab(box, appId);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Add failed.", "error");
    }
  });

  // GitHub
  const ghBox = el("div");
  const renderGithub = async () => {
    if (!link) {
      const remote = textInput({ id: "gh-remote", placeholder: "https://github.com/you/repo.git" });
      const branch = textInput({ id: "gh-branch", placeholder: "main", value: "main" });
      ghBox.replaceChildren(
        el("div", {}, [
          field("Remote URL", remote, { hint: "HTTPS remotes only. Store a token in the vault as GITHUB_TOKEN for private repos.", id: "gh-remote" }),
          field("Branch", branch, { id: "gh-branch" }),
          button("Link repository", async () => {
            try {
              await api.linkGithub(appId, remote.value.trim(), branch.value.trim() || "main");
              toast("Repository linked.", "success");
              await renderDeployTab(box, appId);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Link failed.", "error");
            }
          }, "primary"),
        ]),
      );
      return;
    }
    try {
      const status = await api.githubStatus(appId);
      const msg = textInput({ placeholder: "Commit message" });
      ghBox.replaceChildren(
        el("div", { class: "stack" }, [
          el("p", {}, [text("Linked: "), el("code", { class: "mono" }, [text(link.remote_url)]), text(` (${link.branch})`)]),
          el("div", { class: "row" }, [
            badge(status.clean ? "clean" : "dirty", status.clean ? "success" : "warning"),
            badge(`ahead ${status.ahead} / behind ${status.behind}`, "neutral"),
            badge(status.sha ? status.sha.slice(0, 8) : "no commits", "neutral"),
          ]),
          status.conflicted.length > 0
            ? el("div", { class: "callout callout-danger" }, [el("p", {}, [text(`Merge conflicts in: ${status.conflicted.join(", ")}. Resolve them in the linked repo, then pull again.`)])])
            : el("span"),
          status.modified.length > 0 ? el("p", { class: "card-hint" }, [text(`Modified: ${status.modified.join(", ")}`)]) : el("span"),
          el("div", { class: "row" }, [
            field("Commit message", msg),
            button("Push", async () => {
              try {
                const res = await api.githubPush(appId, msg.value.trim() || "Studio changes");
                toast(res.pushed ? `Pushed (${res.sha?.slice(0, 8) ?? "ok"}).` : "Nothing to push.", "success");
                await renderGithub();
              } catch (err) {
                toast(err instanceof Error ? err.message : "Push failed.", "error");
              }
            }, "primary"),
            button("Pull", async () => {
              try {
                const res = await api.githubPull(appId);
                if (!res.pulled) toast(`Pull blocked by conflicts: ${res.conflicted.join(", ")}`, "error");
                else toast(`Pulled. Imported: ${res.imported.join(", ") || "nothing new"}.`, "success");
                await renderGithub();
              } catch (err) {
                toast(err instanceof Error ? err.message : "Pull failed.", "error");
              }
            }),
          ]),
        ]),
      );
    } catch (err) {
      ghBox.replaceChildren(el("div", { class: "callout callout-danger" }, [el("p", {}, [text(err instanceof Error ? err.message : "Could not read git status.")])]));
    }
  };
  void renderGithub();

  // Eject
  const ejectBtn = button("Download eject bundle (.tar)", async () => {
    const ok = await confirmDialog(
      "Eject this app?",
      "Downloads a standalone bundle: docker-compose + Postgres + a standalone API server + your frontend + a data dump. The ejected app runs without this platform.",
      "Download bundle",
    );
    if (!ok) return;
    try {
      const token = await api.ejectCsrf();
      const res = await fetch(api.ejectUrl(appId), {
        credentials: "same-origin",
        headers: { "x-csrf-token": token },
        method: "POST",
      });
      if (!res.ok) throw new ApiError(res.status, `Eject failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: "eject.tar" }) as HTMLAnchorElement;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Eject bundle downloaded.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Eject failed.", "error");
    }
  });

  box.replaceChildren(
    sectionCard("Deployments", deployments.length === 0 ? emptyState("No deployments yet", "Deploy the current project files to staging from the Studio, or here.") : el("div", { class: "table-wrap" }, [depTable])),
    deployBtns,
    sectionCard("Custom domains", el("div", { class: "stack" }, [
      domains.length === 0 ? el("p", { class: "card-hint" }, [text("No custom domains yet.")]) : el("div", { class: "table-wrap" }, [domainTable]),
      el("div", { class: "row", style: "align-items: end" }, [field("Hostname", hostname), field("Environment", envSel), addDomainBtn]),
    ]), { hint: "Caddy terminates TLS automatically once DNS points at this server." }),
    sectionCard("Generated Caddyfile", codeBlock(caddyfile, "Generated Caddyfile")),
    sectionCard("GitHub sync", ghBox, { hint: "Two-way sync: push writes project files to the repo; pull imports repo changes back. Tokens come from the vault and never appear in logs." }),
    sectionCard("Eject", el("div", {}, [
      el("p", {}, [text("Own your code outright. The bundle includes a standalone server, your data, and a README — no platform lock-in.")]),
      ejectBtn,
    ])),
  );
}

async function renderAuditTab(box: HTMLElement, appId: string): Promise<void> {
  const { events } = await api.listAudit(appId);
  const rows = events.map((e) =>
    el("tr", {}, [
      el("td", {}, [text(formatDate(e.timestamp))]),
      el("td", { class: "mono" }, [text(e.action)]),
      el("td", {}, [text(`${e.actorType}:${e.actorId.slice(0, 12)}`)]),
      el("td", { class: "mono" }, [text(e.detail ? JSON.stringify(e.detail) : "—")]),
    ]),
  );
  const table = el("table", { class: "data-table" });
  table.append(
    el("thead", {}, [el("tr", {}, ["Time", "Action", "Actor", "Detail"].map((h) => el("th", {}, [text(h)])))]),
    el("tbody", {}, rows),
  );
  box.replaceChildren(
    sectionCard(
      "Audit log",
      events.length === 0 ? emptyState("No audit events", "Actions on this app — deploys, profile edits, key creation, MCP calls — are recorded here.") : el("div", { class: "table-wrap" }, [table]),
      { hint: "Newest first, up to 50 entries." },
    ),
  );
}

export async function renderOps(root: HTMLElement, ctx: ViewContext, appId: string): Promise<void> {
  await withLoading(root, async () => {
    const { app } = await api.getApp(appId);
    const box = el("div", { class: "stack" });
    let active = "functions";
    const bar = el("div");
    const renderTab = async () => {
      bar.replaceChildren(tabs(
        [
          { id: "functions", label: "Functions" },
          { id: "billing", label: "Billing" },
          { id: "webhooks", label: "Webhooks" },
          { id: "deploy", label: "Deploy & GitHub" },
          { id: "audit", label: "Audit log" },
        ],
        active,
        (id) => {
          active = id;
          void renderTab();
        },
      ));
      box.replaceChildren(el("p", { class: "card-hint" }, [text("Loading…")]));
      try {
        if (active === "functions") await renderFunctionsTab(box, appId);
        else if (active === "billing") await renderBillingTab(box, appId);
        else if (active === "webhooks") await renderWebhooksTab(box, appId);
        else if (active === "deploy") await renderDeployTab(box, appId);
        else await renderAuditTab(box, appId);
      } catch (err) {
        box.replaceChildren(el("div", { class: "callout callout-danger" }, [el("p", {}, [text(err instanceof Error ? err.message : "Could not load this section.")])]));
      }
    };
    root.replaceChildren(
      pageHead(app.name, `Functions & Ops · ${BRANDING.name} runs your logic, billing, webhooks, and deploys from here.`),
      appNav(appId, "ops"),
      bar,
      box,
    );
    await renderTab();
  });
}
