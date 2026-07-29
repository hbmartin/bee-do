// POST /api/ingest
// Receives an annotation bundle from the extension, opens a channel for the
// request, and posts the marked-up screenshot plus the captured page context.
//
// Env:
//   SLACK_BOT_TOKEN   xoxb-… with chat:write, files:write, channels:manage
//   ANNOTATE_SECRET   shared secret the extension sends back
//   SLACK_CHANNEL_ID  optional — post everything here instead of per-request channels
//   SLACK_INVITE_USERS  optional — comma-separated member IDs to pull into new channels

const SLACK = "https://slack.com/api";

async function slack(method, body, token) {
  const res = await fetch(`${SLACK}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`slack.${method}: ${json.error}`);
  return json;
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "page";

function channelName(bundle) {
  const day = bundle.capturedAt.slice(2, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `req-${day}-${slug(bundle.page.path)}-${rand}`.slice(0, 80);
}

function blocks(bundle) {
  const { page, annotations, requester, project } = bundle;
  const list = annotations
    .map((a) => `*${a.n}.*  ${a.note}`)
    .join("\n");

  const out = [
    {
      type: "header",
      text: { type: "plain_text", text: `Change request · ${project || "app"}` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${requester || "unknown"}* · <${page.url}|${page.path}${page.search}> · ${page.viewport.w}×${page.viewport.h} @${page.dpr}x`,
        },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: list || "_no notes_" } },
  ];

  if (bundle.consoleErrors?.length) {
    const text = bundle.consoleErrors
      .slice(-6)
      .map((e) => `[${e.level}] ${e.message}`)
      .join("\n")
      .slice(0, 2600);
    out.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Console at capture time*\n\`\`\`${text}\`\`\`` },
    });
  }

  if (bundle.clickTrace?.length) {
    const text = bundle.clickTrace
      .slice(-5)
      .map((c) => `${c.selector}${c.text ? `  "${c.text}"` : ""}`)
      .join("\n")
      .slice(0, 1200);
    out.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Last clicks*\n\`\`\`${text}\`\`\`` },
    });
  }

  return out;
}

async function uploadScreenshot({ token, channel, threadTs, dataUrl, name }) {
  const [header, b64] = dataUrl.split(",");
  const mime = /data:(.*?);/.exec(header)?.[1] || "image/png";
  const bytes = Buffer.from(b64, "base64");
  const filename = `${name}.${mime === "image/jpeg" ? "jpg" : "png"}`;

  const params = new URLSearchParams({
    filename,
    length: String(bytes.length),
  });
  const ticketRes = await fetch(
    `${SLACK}/files.getUploadURLExternal?${params}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const ticket = await ticketRes.json();
  if (!ticket.ok) throw new Error(`slack.getUploadURL: ${ticket.error}`);

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const put = await fetch(ticket.upload_url, { method: "POST", body: form });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);

  return slack(
    "files.completeUploadExternal",
    {
      files: [{ id: ticket.file_id, title: "Annotated capture" }],
      channel_id: channel,
      thread_ts: threadTs,
    },
    token
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }
  if (req.headers["x-annotate-secret"] !== process.env.ANNOTATE_SECRET) {
    return res.status(401).json({ ok: false, error: "Bad secret" });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const bundle = req.body;

  if (!token) return res.status(500).json({ ok: false, error: "No SLACK_BOT_TOKEN" });
  if (!bundle?.screenshot || !Array.isArray(bundle.annotations)) {
    return res.status(400).json({ ok: false, error: "Malformed bundle" });
  }

  try {
    let channel = process.env.SLACK_CHANNEL_ID;
    let name = channel;

    if (!channel) {
      name = channelName(bundle);
      const created = await slack("conversations.create", { name }, token);
      channel = created.channel.id;

      const invites = (process.env.SLACK_INVITE_USERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (invites.length) {
        await slack(
          "conversations.invite",
          { channel, users: invites.join(",") },
          token
        ).catch(() => {}); // already-in-channel is not worth failing over
      }
    }

    const posted = await slack(
      "chat.postMessage",
      {
        channel,
        text: `Change request from ${bundle.requester || "unknown"} on ${bundle.page.path}`,
        blocks: blocks(bundle),
        unfurl_links: false,
      },
      token
    );

    await uploadScreenshot({
      token,
      channel,
      threadTs: posted.ts,
      dataUrl: bundle.screenshot,
      name: `capture-${posted.ts}`,
    });

    return res.status(200).json({
      ok: true,
      channel: name?.startsWith("C") ? channel : `#${name}`,
      ts: posted.ts,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
