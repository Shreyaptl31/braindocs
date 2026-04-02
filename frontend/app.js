const API = "";
const MAX = 5;
let docs = [], activeDoc = null, fileToUpload = null;
let sessionId = null;
let messagesLeft = MAX;

async function initSession() {
    try {
        const r = await fetch(`${API}/health`);
        if (r.ok) {
            document.getElementById("apiDot").classList.add("live");
            document.getElementById("apiStatus").textContent = "live";
        }
    } catch { document.getElementById("apiStatus").textContent = "api · offline"; }

    try {
        const r = await fetch(`${API}/session`, { method: "POST" });
        if (r.ok) {
            const d = await r.json();
            sessionId = d.session_id;
            messagesLeft = MAX;
            updateCounter(0, MAX);
        }
    } catch { }
}

function updateCounter(used, total) {
    const text = document.getElementById("counterText");
    const dot = document.getElementById("msgDot");
    const left = total - used;

    text.textContent = left === 1 ? "1 message left" : `${left} messages left`;

    dot.className = "msg-dot" +
        (left === 0 ? " danger" : left <= 1 ? " danger" : left <= 2 ? " warn" : "");
}

function lockInput() {
    document.getElementById("queryBox").disabled = true;
    document.getElementById("sendBtn").disabled = true;
    document.getElementById("limitBanner").classList.add("show");
    document.getElementById("inputRow").style.display = "none";
}

// ── File pick ──
const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const uploadBtn = document.getElementById("uploadBtn");

function setFile(f) {
    if (!f || !f.name.endsWith(".pdf")) return toast("Only PDF files allowed", "err");
    fileToUpload = f;
    document.getElementById("selectedName").textContent = f.name;
    document.getElementById("selectedSize").textContent = (f.size / 1024).toFixed(1) + " KB";
    document.getElementById("fileSelected").classList.add("show");
    uploadBtn.disabled = false;
}

fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", e => {
    e.preventDefault(); dropZone.classList.remove("over"); setFile(e.dataTransfer.files[0]);
});

// ── Upload ──
uploadBtn.addEventListener("click", async () => {
    if (!fileToUpload) return;
    uploadBtn.disabled = true;

    const wrap = document.getElementById("progressWrap");
    const fill = document.getElementById("progressFill");
    const txt = document.getElementById("progressText");
    wrap.style.display = "block";

    let pct = 0;
    const tick = setInterval(() => {
        pct = Math.min(pct + Math.random() * 12, 88);
        fill.style.width = pct + "%";
    }, 300);

    const form = new FormData();
    form.append("file", fileToUpload);

    try {
        const res = await fetch(`${API}/upload`, { method: "POST", body: form });
        clearInterval(tick);
        if (!res.ok) throw new Error((await res.json()).detail || "Upload failed");

        const data = await res.json();
        fill.style.width = "100%";
        txt.textContent = `✓ ${data.pages} pages · ${data.chunks} chunks`;

        docs.push({ name: data.filename, col: data.collection_name, pages: data.pages, chunks: data.chunks });
        renderDocs();
        toast(`"${data.filename}" indexed!`, "ok");
        fileToUpload = null;
        fileInput.value = "";
        document.getElementById("fileSelected").classList.remove("show");
        setTimeout(() => { wrap.style.display = "none"; fill.style.width = "0%"; }, 3000);
    } catch (e) {
        clearInterval(tick);
        wrap.style.display = "none";
        fill.style.width = "0%";
        uploadBtn.disabled = false;
        toast(e.message, "err");
    }
});

// ── Doc list ──
function renderDocs() {
    const el = document.getElementById("docList");
    if (!docs.length) {
        el.innerHTML = `<div style="font-size:0.78rem;color:var(--muted);text-align:center;padding:16px 0;">No documents yet</div>`;
        return;
    }
    el.innerHTML = docs.map((d, i) => `
    <div class="doc-item ${activeDoc === i ? "active" : ""}" onclick="selectDoc(${i})">
      <div class="doc-thumb">📋</div>
      <div class="doc-info">
        <div class="doc-name">${d.name}</div>
        <div class="doc-stat">${d.pages} pages · ${d.chunks} chunks</div>
      </div>
      <div class="doc-active-dot"></div>
    </div>`).join("");
}

function selectDoc(i) {
    activeDoc = i;
    renderDocs();
    if (messagesLeft > 0) {
        document.getElementById("queryBox").disabled = false;
        document.getElementById("sendBtn").disabled = false;
    }
    document.getElementById("queryBox").placeholder = `Ask about "${docs[i].name}"…`;
    resetChat();
}

function resetChat() {
    document.getElementById("messages").innerHTML = `
    <div class="empty" id="emptyState">
      <div class="empty-icon">✨</div>
      <h3>Ready to answer</h3>
      <p>Ask anything about <strong>${docs[activeDoc].name}</strong></p>
      <div class="session-notice"><span>⚡</span> Free session — <strong>5 messages</strong> per visit</div>
    </div>`;
}

// ── Query ──
document.getElementById("sendBtn").addEventListener("click", ask);
document.getElementById("queryBox").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
});

async function ask() {
    if (messagesLeft <= 0) return lockInput();
    const box = document.getElementById("queryBox");
    const q = box.value.trim();
    if (!q || activeDoc === null) return;

    box.value = "";
    document.getElementById("sendBtn").disabled = true;
    const emptyEl = document.getElementById("emptyState");
    if (emptyEl) emptyEl.remove();

    addMsg("user", q);
    const loader = addLoader();

    try {
        const res = await fetch(`${API}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId || "" },
            body: JSON.stringify({ query: q, collection_name: docs[activeDoc].col }),
        });

        if (!res.ok) {
            const err = await res.json();
            if (res.status === 429) { loader.remove(); lockInput(); updateCounter(MAX, MAX); return; }
            throw new Error(err.detail || "Query failed");
        }

        const data = await res.json();
        sessionId = data.session_id;
        messagesLeft = data.messages_left;
        updateCounter(data.messages_used, MAX);

        loader.remove();
        addMsg("ai", data.answer, data.sources);

        if (messagesLeft === 0) {
            lockInput();
            toast("You've used all 5 messages. Refresh to start a new session.", "warn");
        } else if (messagesLeft === 1) {
            toast("⚠️ Last message remaining!", "warn");
        }
    } catch (e) {
        loader.remove();
        addMsg("ai", `⚠️ ${e.message}`);
        toast(e.message, "err");
    }

    if (messagesLeft > 0) {
        document.getElementById("sendBtn").disabled = false;
        box.focus();
    }
}

function addMsg(role, text, sources = []) {
    const msgs = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    const pages = [...new Set((sources || []).map(s => s.page))];
    const chips = pages.map(p => `<span class="src-chip">📄 pg ${p}</span>`).join("");
    div.innerHTML = `
    <div class="msg-who"><span class="who-dot"></span>${role === "user" ? "You" : "BrainDoc AI"}</div>
    <div class="bubble">${esc(text).replace(/\n/g, "<br>")}</div>
    ${role === "ai" && pages.length ? `<div class="sources">${chips}</div>` : ""}`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
}

function addLoader() {
    const msgs = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "msg ai";
    div.innerHTML = `
    <div class="msg-who"><span class="who-dot"></span>BrainDoc AI</div>
    <div class="typing"><span></span><span></span><span></span></div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
}

function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toast(msg, type = "ok") {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

initSession();