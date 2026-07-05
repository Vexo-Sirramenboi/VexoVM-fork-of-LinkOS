    (async () => {
      const BOOT_HTML = "<!doctype html>\n" + document.documentElement.outerHTML;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const COMPRESSED_BOOT = __LINKOS_COMPRESSED_BOOT__;
      const baseFiles = await loadRootfs(__LINKOS_ROOTFS__);
      const STATE_VERSION = 1;

      const defaultState = () => {
        const release = osRelease(baseFiles);
        return {
          stateVersion: STATE_VERSION,
          bootId: cryptoRandomId(),
          username: "user",
          files: { ...baseFiles },
          activeFile: "/notes.txt",
          previewFile: "/workspace/preview.html",
          fileManagerDir: "/workspace",
          cwd: "/",
          terminal: [
            `${release.prettyName} ${release.version}`,
            "opaque origin detected; in-memory rootfs mounted at /",
            "type `help` for commands"
          ],
          windows: {
            terminal: { x: 24, y: 24, w: 570, h: 360, open: true },
            editor: { x: 620, y: 24, w: 560, h: 420, open: true },
            files: { x: 24, y: 408, w: 470, h: 310, open: true },
            processes: { x: 1204, y: 24, w: 440, h: 370, open: true },
            preview: { x: 520, y: 468, w: 560, h: 320, open: true }
          },
          z: 10,
          nextPid: 1200,
          lastExport: ""
        };
      };

      const appSpecs = [
        { id: "terminal", title: "Terminal", render: renderTerminal },
        { id: "editor", title: "Editor", render: renderEditor },
        { id: "files", title: "Filesystem", render: renderFiles },
        { id: "processes", title: "Processes", render: renderProcesses },
        { id: "preview", title: "Browser", render: renderPreview }
      ];

      const els = {
        workspace: document.getElementById("workspace"),
        dock: document.getElementById("dock"),
        statusLine: document.getElementById("statusLine"),
        exportButton: document.getElementById("exportButton"),
        resetButton: document.getElementById("resetButton"),
        urlBox: document.getElementById("urlBox"),
        urlOutput: document.getElementById("urlOutput"),
        urlStats: document.getElementById("urlStats"),
        hideUrlButton: document.getElementById("hideUrlButton"),
        toast: document.getElementById("toast")
      };

      const loaded = await loadState();
      const runtime = {
        state: loaded.state,
        restoreError: loaded.error,
        workers: new Map(),
        processLog: [],
        meters: { cpu: 0, heap: 0, io: 0 },
        previewFrame: null,
        previewKey: "",
        commandHistory: [],
        commandHistoryIndex: 0,
        focusOwner: "",
        toastTimer: 0
      };

      window.addEventListener("message", (event) => {
        if (event.data && event.data.type === "sandbox-note") {
          logTerminal("[iframe] " + event.data.text);
          toast("Browser message: " + event.data.text);
        }
      });

      els.exportButton.addEventListener("click", () => showExportUrl());
      els.resetButton.addEventListener("click", () => resetMachine());
      els.hideUrlButton.addEventListener("click", () => els.urlBox.dataset.open = "false");

      if (runtime.restoreError) {
        runtime.state.terminal.push(`warning: saved state could not be restored (${runtime.restoreError})`);
      }
      render();
      startSystemPulse();
      if (runtime.restoreError) toast("State restore failed; started a clean machine");

      function render() {
        persistHash();
        els.statusLine.textContent = statusText();
        els.workspace.replaceChildren();
        els.dock.replaceChildren();

        appSpecs.forEach((spec) => {
          const winState = runtime.state.windows[spec.id];
          const dockButton = document.createElement("button");
          dockButton.textContent = spec.title;
          dockButton.addEventListener("click", () => {
            winState.open = !winState.open;
            focusWindow(spec.id);
            render();
          });
          els.dock.appendChild(dockButton);

          if (!winState.open) return;
          const win = document.createElement("article");
          win.className = "window";
          win.dataset.app = spec.id;
          win.style.left = winState.x + "px";
          win.style.top = winState.y + "px";
          win.style.width = winState.w + "px";
          win.style.height = winState.h + "px";
          win.style.zIndex = winState.z || 1;
          win.dataset.focused = String((winState.z || 1) === runtime.state.z);

          const titlebar = document.createElement("header");
          titlebar.className = "titlebar";
          titlebar.innerHTML = `<span class="title">${escapeHtml(spec.title)}</span>`;

          const lights = document.createElement("div");
          lights.className = "lights";
          lights.addEventListener("pointerdown", (event) => event.stopPropagation());
          const close = lightButton("close", "Close");
          const min = lightButton("min", "Minimize");
          const max = lightButton("max", "Maximize");
          close.addEventListener("click", () => {
            winState.open = false;
            render();
          });
          min.addEventListener("click", () => {
            winState.open = false;
            render();
          });
          max.addEventListener("click", () => {
            toggleMaximize(spec.id);
            render();
          });
          lights.append(close, min, max);
          titlebar.appendChild(lights);
          titlebar.addEventListener("pointerdown", (event) => dragWindow(event, spec.id));

          const content = document.createElement("section");
          content.className = "content";
          spec.render(content);

          win.addEventListener("pointerdown", () => focusWindow(spec.id));
          win.append(titlebar, content);
          appendResizeHandles(win, spec.id);
          els.workspace.appendChild(win);
        });
      }

      function refreshApp(id) {
        const spec = appSpecs.find((candidate) => candidate.id === id);
        const winState = runtime.state.windows[id];
        if (!spec || !winState || !winState.open) return;
        const win = els.workspace.querySelector(`[data-app="${id}"]`);
        const content = win?.querySelector(".content");
        if (!content) return;
        content.replaceChildren();
        spec.render(content);
        els.statusLine.textContent = statusText();
      }

      function renderTerminal(root) {
        const log = document.createElement("div");
        log.className = "terminal-log";
        log.textContent = runtime.state.terminal.join("\n");

        const form = document.createElement("form");
        form.className = "terminal-form";
        form.innerHTML = `<span class="prompt">${escapeHtml(runtime.state.username || "user")}@linkos:${escapeHtml(runtime.state.cwd || "/")}$</span><input aria-label="Terminal command" autocomplete="off" spellcheck="false">`;
        const input = form.querySelector("input");
        input.addEventListener("focus", () => {
          runtime.focusOwner = "terminal";
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!runtime.commandHistory.length) return;
            runtime.commandHistoryIndex = Math.max(0, runtime.commandHistoryIndex - 1);
            input.value = runtime.commandHistory[runtime.commandHistoryIndex] || "";
            queueMicrotask(() => input.setSelectionRange(input.value.length, input.value.length));
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!runtime.commandHistory.length) return;
            runtime.commandHistoryIndex = Math.min(runtime.commandHistory.length, runtime.commandHistoryIndex + 1);
            input.value = runtime.commandHistory[runtime.commandHistoryIndex] || "";
            queueMicrotask(() => input.setSelectionRange(input.value.length, input.value.length));
          }
        });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const command = input.value.trim();
          if (!command) return;
          if (runtime.commandHistory.at(-1) !== command) runtime.commandHistory.push(command);
          runtime.commandHistory = runtime.commandHistory.slice(-80);
          runtime.commandHistoryIndex = runtime.commandHistory.length;
          logTerminal("> " + command);
          runCommand(command);
          input.value = "";
          render();
        });

        root.append(log, form);
        queueMicrotask(() => {
          log.scrollTop = log.scrollHeight;
          if (runtime.focusOwner === "terminal") {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        });
      }

      function renderEditor(root) {
        const tools = document.createElement("div");
        tools.className = "editor-tools";

        const path = document.createElement("input");
        path.value = runtime.state.activeFile;
        path.setAttribute("aria-label", "File path");

        const save = document.createElement("button");
        save.textContent = "Save";
        const remove = document.createElement("button");
        remove.textContent = "Delete";

        tools.append(path, save, remove);

        const body = document.createElement("textarea");
        body.className = "editor-body";
        body.value = runtime.state.files[runtime.state.activeFile] || "";
        body.spellcheck = false;
        body.setAttribute("aria-label", "File contents");

        save.addEventListener("click", () => {
          const normalized = normalizePath(path.value);
          runtime.state.activeFile = normalized;
          runtime.state.files[normalized] = body.value;
          logTerminal("saved " + normalized);
          toast("Saved " + normalized);
          render();
        });

        remove.addEventListener("click", () => {
          const normalized = normalizePath(path.value);
          if (runtime.state.files[normalized] == null) {
            toast("No saved file to delete");
            return;
          }
          delete runtime.state.files[normalized];
          if (runtime.state.previewFile === normalized) runtime.state.previewFile = "/workspace/preview.html";
          runtime.state.activeFile = firstFileInDirectory(runtime.state.fileManagerDir) || "/readme.txt";
          logTerminal("removed " + normalized);
          render();
        });

        root.append(tools, body);
      }

      function renderFiles(root) {
        const tools = document.createElement("div");
        tools.className = "fs-tools";
        const add = document.createElement("button");
        add.textContent = "New File";
        add.addEventListener("click", () => {
          const path = normalizePath("untitled-" + Date.now().toString(36) + ".txt", runtime.state.fileManagerDir || "/workspace");
          runtime.state.activeFile = path;
          runtime.state.windows.editor.open = true;
          focusWindow("editor");
          render();
        });
        const pathDisplay = document.createElement("input");
        pathDisplay.value = runtime.state.fileManagerDir || runtime.state.cwd || "/workspace";
        pathDisplay.setAttribute("aria-label", "Current directory");
        pathDisplay.readOnly = true;
        tools.append(pathDisplay, add);

        const grid = document.createElement("div");
        grid.className = "fs-grid";
        directoryEntries(runtime.state.fileManagerDir || "/workspace").forEach((entry) => {
          const tile = document.createElement("button");
          tile.className = "file-tile";
          tile.innerHTML = [
            `<span class="file-name">${escapeHtml(entry.name)}</span>`,
            `<span class="file-meta">${entry.type === "dir" ? "directory" : entry.size + " bytes"}</span>`
          ].join("");
          tile.addEventListener("click", () => {
            if (entry.type === "dir") {
              runtime.state.fileManagerDir = entry.path;
              render();
              return;
            }
            openVirtualFile(entry.path);
            render();
          });
          grid.appendChild(tile);
        });

        root.append(tools, grid);
      }

      function renderProcesses(root) {
        const meters = document.createElement("div");
        meters.append(
          meterRow("cpu", runtime.meters.cpu),
          meterRow("heap", runtime.meters.heap),
          meterRow("io", runtime.meters.io % 100)
        );

        const tableWrap = document.createElement("div");
        tableWrap.style.overflow = "auto";
        tableWrap.innerHTML = processTableHtml();

        const log = document.createElement("div");
        log.className = "process-log";
        log.textContent = runtime.processLog.slice(-80).join("\n") || "No worker process yet.";

        root.append(meters, tableWrap, log);
      }

      function renderPreview(root) {
        const previewPath = runtime.state.previewFile || "/workspace/preview.html";
        const html = runtime.state.files[previewPath] || `<p>Missing ${escapeHtml(previewPath)}</p>`;
        const bar = document.createElement("div");
        bar.className = "browser-bar";
        bar.innerHTML = `<span class="address-bar">linkos://${escapeHtml(previewPath.replace(/^\/+/, ""))}</span>`;
        const key = previewPath + "\n" + html;
        const frame = runtime.previewFrame || document.createElement("iframe");
        if (!runtime.previewFrame) {
          frame.className = "sandbox-frame";
          frame.setAttribute("sandbox", "allow-scripts");
          runtime.previewFrame = frame;
        }
        if (runtime.previewKey !== key) {
          frame.srcdoc = [
          "<!doctype html><html><head><style>",
          "body{margin:0;padding:22px;font:15px system-ui;background:#fff;color:#241f31}",
          "h1{margin:0 0 10px;font-size:24px;letter-spacing:0}",
          "code{background:#f1edf4;border-radius:4px;padding:2px 4px}",
          "button{border:1px solid #e95420;background:#e95420;color:#fff;border-radius:7px;padding:8px 12px;cursor:pointer}",
          "<\/style><\/head><body>",
          html,
          "<\/body><\/html>"
          ].join("");
          runtime.previewKey = key;
        }
        root.append(bar, frame);
      }

      function runCommand(command) {
        const [name, ...args] = splitArgs(command);
        const rest = command.slice(name.length).trim();
        const commands = {
          help: () => [
            "commands:",
            "  pwd",
            "  cd <dir>",
            "  help",
            "  ls [-l]",
            "  cat <path>",
            "  grep <pattern> <path>",
            "  wc [-l|-c] <path>",
            "  touch <path>",
            "  write <path> <text>",
            "  nano <path>",
            "  xdg-open <path>",
            "  rm <path>",
            "  cp <from> <to>",
            "  mv <from> <to>",
            "  diff <path-a> <path-b>",
            "  run <path>",
            "  ps",
            "  kill <pid>",
            "  whoami",
            "  setuser <name>",
            "  uname",
            "  export",
            "  clear"
          ].forEach(logTerminal),
          pwd: () => logTerminal(runtime.state.cwd || "/"),
          cd: () => {
            const path = normalizePath(args[0] || "/");
            if (!directoryExists(path)) {
              logTerminal("bash: cd: " + path + ": No such file or directory");
              return;
            }
            runtime.state.cwd = path;
          },
          ls: () => listFiles(args).forEach(logTerminal),
          cat: () => {
            const path = normalizePath(args[0] || "");
            logTerminal(runtime.state.files[path] ?? "missing: " + path);
          },
          grep: () => grepFile(args[0] || "", normalizePath(args[1] || "")),
          wc: () => wcFile(args),
          touch: () => {
            if (!args[0]) {
              logTerminal("touch: missing file operand");
              return;
            }
            const path = normalizePath(args[0] || "");
            if (!(path in runtime.state.files)) runtime.state.files[path] = "";
            runtime.state.activeFile = path;
            logTerminal(path);
          },
          write: () => {
            if (!args[0]) {
              logTerminal("write: missing file operand");
              return;
            }
            const path = normalizePath(args[0] || "");
            const text = rest.slice((args[0] || "").length).trim();
            runtime.state.files[path] = text;
            runtime.state.activeFile = path;
            logTerminal("wrote " + byteLength(text) + " bytes to " + path);
          },
          open: () => {
            const path = normalizePath(args[0] || "");
            if (!(path in runtime.state.files)) {
              logTerminal("missing: " + path);
              return;
            }
            runtime.state.activeFile = path;
            runtime.state.windows.editor.open = true;
            focusWindow("editor");
          },
          edit: () => {
            const path = normalizePath(args[0] || "/workspace/main.js");
            if (!(path in runtime.state.files)) runtime.state.files[path] = "";
            runtime.state.activeFile = path;
            runtime.state.windows.editor.open = true;
            focusWindow("editor");
          },
          nano: () => commands.edit(),
          "xdg-open": () => {
            const path = normalizePath(args[0] || ".");
            if (directoryExists(path) && runtime.state.files[path] == null) {
              openDirectory(path);
              return;
            }
            if (runtime.state.files[path] == null) {
              logTerminal("xdg-open: no such file: " + path);
              return;
            }
            openVirtualFile(path);
          },
          rm: () => {
            const path = normalizePath(args[0] || "");
            if (!(path in runtime.state.files)) {
              logTerminal("missing: " + path);
              return;
            }
            delete runtime.state.files[path];
            if (runtime.state.activeFile === path) runtime.state.activeFile = "/readme.txt";
            logTerminal("removed " + path);
          },
          cp: () => {
            const from = normalizePath(args[0] || "");
            const to = normalizePath(args[1] || "");
            if (!(from in runtime.state.files)) {
              logTerminal("missing: " + from);
              return;
            }
            runtime.state.files[to] = runtime.state.files[from];
            logTerminal("copied " + from + " -> " + to);
          },
          mv: () => {
            const from = normalizePath(args[0] || "");
            const to = normalizePath(args[1] || "");
            if (!(from in runtime.state.files)) {
              logTerminal("mv: cannot stat '" + from + "': No such file");
              return;
            }
            runtime.state.files[to] = runtime.state.files[from];
            delete runtime.state.files[from];
            if (runtime.state.activeFile === from) runtime.state.activeFile = to;
            if (runtime.state.previewFile === from) runtime.state.previewFile = to;
            logTerminal("renamed " + from + " -> " + to);
          },
          diff: () => diffFiles(normalizePath(args[0] || ""), normalizePath(args[1] || "")),
          run: () => {
            startWorkerProcess(normalizePath(args[0] || "/workspace/main.js"));
          },
          ps: () => {
            const rows = processRows();
            if (!rows.length) {
              logTerminal("no user processes");
              return;
            }
            logTerminal("PID   STATE    PATH");
            rows.forEach((row) => logTerminal(`${row.pid}  ${row.state.padEnd(7)} ${row.path}`));
          },
          kill: () => stopWorkerProcess(args[0], { quiet: false }),
          whoami: () => logTerminal(runtime.state.username || "user"),
          setuser: () => {
            const name = (args[0] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
            if (!name) {
              logTerminal("setuser: usage: setuser <name>");
              return;
            }
            runtime.state.username = name;
            logTerminal("user set to " + name);
          },
          uname: () => {
            const release = osRelease(runtime.state.files);
            logTerminal(`${release.name} ${release.version} data-url-workstation opaque-origin wasm-ready`);
          },
          echo: () => logTerminal(rest),
          date: () => logTerminal(new Date().toString()),
          clear: () => {
            runtime.state.terminal = [];
          },
          export: () => showExportUrl(),
        };

        if (!commands[name]) {
          logTerminal("unknown command: " + name);
          return;
        }
        commands[name]();
      }

      async function showExportUrl() {
        runtime.focusOwner = "";
        const result = await makeExportUrl();
        const dataUrl = result.url;
        runtime.state.lastExport = dataUrl;
        els.urlOutput.value = dataUrl;
        els.urlStats.textContent = `${formatBytes(dataUrl.length)} standalone URL, ${result.compressed ? "compressed" : "plain"} state, ${Object.keys(runtime.state.files).length} files`;
        els.urlBox.style.zIndex = String(runtime.state.z + 100);
        els.urlBox.dataset.open = "true";
        queueMicrotask(() => {
          els.urlOutput.focus();
          els.urlOutput.select();
        });
        toast("Standalone boot URL generated");
      }

      async function makeExportUrl() {
        const exportState = {
          ...runtime.state,
          lastExport: ""
        };
        const json = JSON.stringify(exportState);
        let payload = encodeState(exportState);
        let compressed = false;
        if ("CompressionStream" in window) {
          try {
            payload = "gz:" + bytesToBase64Url(await gzipString(json));
            compressed = true;
          } catch (error) {
            payload = encodeState(exportState);
          }
        }
        return {
          compressed,
          url: await makeBootDataUrl(BOOT_HTML) + "#state=" + payload
        };
      }

      async function loadRootfs(image) {
        if (image && image.gz) return JSON.parse(await gunzipString(base64UrlToBytes(image.gz)));
        return image || {};
      }

      async function loadState() {
        const hash = location.hash.startsWith("#state=") ? location.hash.slice(7) : "";
        if (!hash) return { state: defaultState(), error: null };
        try {
          const text = hash.startsWith("gz:")
            ? await gunzipString(base64UrlToBytes(hash.slice(3)))
            : decoder.decode(base64UrlToBytes(hash));
          const decoded = JSON.parse(text);
          return { state: hydrateState(decoded), error: null };
        } catch (error) {
          return {
            state: defaultState(),
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }

      function hydrateState(candidate) {
        const migrated = migrateState(candidate);
        const fresh = defaultState();
        const files = migrated.files && typeof migrated.files === "object" && !Array.isArray(migrated.files)
          ? migrated.files
          : {};
        const windows = migrated.windows && typeof migrated.windows === "object" && !Array.isArray(migrated.windows)
          ? migrated.windows
          : {};
        return {
          ...fresh,
          ...migrated,
          stateVersion: STATE_VERSION,
          files: { ...fresh.files, ...files },
          windows: { ...fresh.windows, ...windows },
          terminal: Array.isArray(migrated.terminal) ? migrated.terminal : fresh.terminal
        };
      }

      function migrateState(candidate) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          throw new Error("state payload is not an object");
        }
        let version = candidate.stateVersion == null ? 0 : candidate.stateVersion;
        if (!Number.isInteger(version) || version < 0) throw new Error("invalid state version");
        if (version > STATE_VERSION) throw new Error(`state version ${version} is newer than supported version ${STATE_VERSION}`);

        if (candidate.files != null && (typeof candidate.files !== "object" || Array.isArray(candidate.files))) {
          throw new Error("state files are invalid");
        }
        if (candidate.windows != null && (typeof candidate.windows !== "object" || Array.isArray(candidate.windows))) {
          throw new Error("state windows are invalid");
        }
        if (candidate.terminal != null && !Array.isArray(candidate.terminal)) {
          throw new Error("state terminal is invalid");
        }

        const migrated = { ...candidate };
        while (version < STATE_VERSION) {
          if (version === 0) {
            migrated.stateVersion = 1;
            version = 1;
            continue;
          }
          throw new Error(`no migration path from state version ${version}`);
        }
        return migrated;
      }

      function persistHash() {
        const payload = encodeState({ ...runtime.state, lastExport: "" });
        history.replaceState(null, "", "#state=" + payload);
      }

      function encodeState(state) {
        return bytesToBase64Url(encoder.encode(JSON.stringify(state)));
      }

      async function gzipString(value) {
        const stream = new Blob([value]).stream().pipeThrough(new CompressionStream("gzip"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }

      async function gunzipString(bytes) {
        if (!("DecompressionStream" in window)) throw new Error("compressed state is not supported in this browser");
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).text();
      }

      function bytesToBase64Url(bytes) {
        return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      }

      function bytesToBase64(bytes) {
        let binary = "";
        bytes.forEach((byte) => binary += String.fromCharCode(byte));
        return btoa(binary);
      }

      function makeDataUrl(html) {
        const percentUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
        const base64Url = "data:text/html;charset=utf-8;base64," + bytesToBase64(encoder.encode(html));
        return base64Url.length < percentUrl.length ? base64Url : percentUrl;
      }

      async function makeBootDataUrl(html) {
        if (!COMPRESSED_BOOT || !("CompressionStream" in window)) return makeDataUrl(html);
        try {
          return makeDataUrl(compressedBootHtml(bytesToBase64(await gzipString(html))));
        } catch (error) {
          return makeDataUrl(html);
        }
      }

      function compressedBootHtml(base64) {
        return `<!doctype html><meta charset="utf-8"><title>linkOS Boot</title><script>(async()=>{try{if(!("DecompressionStream"in self))throw new Error("DecompressionStream is unavailable");const b="${base64}";const bytes=Uint8Array.from(atob(b),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));document.open();document.write(await new Response(stream).text());document.close()}catch(error){document.body.style.cssText="font:15px system-ui;padding:24px";document.body.textContent="linkOS compressed boot failed: "+error.message}})()<\/script>`;
      }

      function base64UrlToBytes(value) {
        const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      }

      function startWorkerProcess(path = "/workspace/main.js") {
        const normalized = normalizePath(path);
        const source = runtime.state.files[normalized];
        if (source == null) {
          logTerminal("missing executable: " + normalized);
          return;
        }
        const pid = runtime.state.nextPid++;
        const fileSnapshot = JSON.stringify(runtime.state.files);
        const sourceLiteral = JSON.stringify(source);
        const workerCode = `
          const fs = ${fileSnapshot};
          const source = ${sourceLiteral};
          const emit = (payload) => postMessage({ type: "user", payload });
          self.addEventListener("error", (event) => {
            postMessage({ type: "error", message: event.message });
          });
          try {
            const run = new Function("emit", "fs", source);
            run(emit, fs);
            postMessage({ type: "ready" });
          } catch (error) {
            postMessage({ type: "error", message: error && error.stack ? error.stack : String(error) });
          }
        `;
        const url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
        const worker = new Worker(url, { name: "linkos-pid-" + pid });
        const proc = {
          pid,
          path: normalized,
          url,
          worker,
          state: "starting",
          started: Date.now(),
          lastMessage: ""
        };
        worker.addEventListener("message", (event) => {
          if (event.data.type === "ready") {
            proc.state = "running";
            proc.lastMessage = "ready";
            runtime.processLog.push(`pid ${pid} ready ${normalized}`);
          }
          if (event.data.type === "error") {
            proc.state = "faulted";
            proc.lastMessage = event.data.message;
            runtime.processLog.push(`pid ${pid} error: ${event.data.message}`);
          }
          if (event.data.type === "user") {
            const payload = event.data.payload || {};
            proc.state = "running";
            proc.lastMessage = payload.text || payload.stream || JSON.stringify(payload);
            if (typeof payload.cpu === "number") runtime.meters.cpu = payload.cpu;
            if (typeof payload.heap === "number") runtime.meters.heap = payload.heap;
            if (typeof payload.io === "number") runtime.meters.io = payload.io;
            if (payload.stream === "stdout" || payload.stream === "metric") {
              runtime.processLog.push(`pid ${pid} ${payload.stream}: ${payload.text || ""}`);
            } else {
              runtime.processLog.push(`pid ${pid}: ${JSON.stringify(payload)}`);
            }
          }
          refreshApp("processes");
        });
        worker.addEventListener("error", (event) => {
          proc.state = "faulted";
          proc.lastMessage = event.message;
          runtime.processLog.push(`pid ${pid} worker error: ${event.message}`);
          refreshApp("processes");
        });
        runtime.workers.set(String(pid), proc);
        runtime.processLog.push(`spawned pid ${pid} from ${normalized}`);
        logTerminal(`spawned pid ${pid} from ${normalized}`);
        render();
      }

      function stopWorkerProcess(pid, options = {}) {
        const key = String(pid || "");
        const proc = runtime.workers.get(key);
        if (!proc) {
          if (!options.quiet) toast("No worker to stop");
          return;
        }
        proc.worker.terminate();
        URL.revokeObjectURL(proc.url);
        runtime.workers.delete(key);
        if (runtime.workers.size === 0) {
          runtime.meters = { cpu: 0, heap: 0, io: 0 };
        }
        runtime.processLog.push(`terminated pid ${proc.pid} ${proc.path}`);
        logTerminal(`terminated pid ${proc.pid}`);
        refreshApp("processes");
        els.statusLine.textContent = statusText();
      }

      function startSystemPulse() {
        setInterval(() => {
          if (runtime.workers.size === 0) return;
          els.statusLine.textContent = statusText();
        }, 1000);
      }

      function processRows() {
        return Array.from(runtime.workers.values())
          .sort((a, b) => a.pid - b.pid)
          .map((proc) => ({
            pid: proc.pid,
            path: proc.path,
            state: proc.state,
            uptime: Math.max(0, Math.round((Date.now() - proc.started) / 1000)),
            lastMessage: proc.lastMessage || ""
          }));
      }

      function processTableHtml() {
        const rows = processRows();
        if (!rows.length) return `<table class="process-table"><tbody><tr><td>No user processes</td></tr></tbody></table>`;
        return [
          `<table class="process-table"><thead><tr><th>PID</th><th>State</th><th>Uptime</th><th>Command</th></tr></thead><tbody>`,
          ...rows.map((row) => `<tr><td>${row.pid}</td><td>${escapeHtml(row.state)}</td><td>${row.uptime}s</td><td>${escapeHtml(row.path)}<br><span class="file-meta">${escapeHtml(row.lastMessage)}</span></td></tr>`),
          `</tbody></table>`
        ].join("");
      }

      function listFiles(args) {
        const long = args.includes("-l");
        const targetArg = args.find((arg) => !arg.startsWith("-"));
        const target = normalizePath(targetArg || runtime.state.cwd || "/");
        const entries = directoryEntries(target);
        if (!entries.length) return ["ls: cannot access '" + target + "': No such file or directory"];
        return entries.map((entry) => {
          if (!long) return entry.name;
          const mode = entry.type === "dir" ? "drwxr-xr-x" : entry.path.endsWith(".js") ? "-rwxr-xr-x" : "-rw-r--r--";
          return `${mode} user user ${String(entry.size).padStart(6)} ${entry.name}`;
        });
      }

      function grepFile(pattern, path) {
        if (!pattern) {
          logTerminal("grep: missing pattern");
          return;
        }
        const content = runtime.state.files[path];
        if (content == null) {
          logTerminal("grep: " + path + ": No such file");
          return;
        }
        const matches = content.split("\n")
          .map((line, index) => ({ line, index: index + 1 }))
          .filter((entry) => entry.line.includes(pattern));
        if (!matches.length) return;
        matches.forEach((entry) => logTerminal(`${path}:${entry.index}:${entry.line}`));
      }

      function wcFile(args) {
        const mode = args[0]?.startsWith("-") ? args[0] : "";
        const path = normalizePath(mode ? args[1] || "" : args[0] || "");
        const content = runtime.state.files[path];
        if (content == null) {
          logTerminal("wc: " + path + ": No such file");
          return;
        }
        const lines = content.length ? content.split("\n").length : 0;
        const words = content.trim() ? content.trim().split(/\s+/).length : 0;
        const bytes = byteLength(content);
        if (mode === "-l") logTerminal(`${lines} ${path}`);
        else if (mode === "-c") logTerminal(`${bytes} ${path}`);
        else logTerminal(`${lines} ${words} ${bytes} ${path}`);
      }

      function diffFiles(a, b) {
        if (!(a in runtime.state.files)) {
          logTerminal("missing: " + a);
          return;
        }
        if (!(b in runtime.state.files)) {
          logTerminal("missing: " + b);
          return;
        }
        const left = runtime.state.files[a].split("\n");
        const right = runtime.state.files[b].split("\n");
        const max = Math.max(left.length, right.length);
        logTerminal("--- " + a);
        logTerminal("+++ " + b);
        for (let i = 0; i < max; i++) {
          if (left[i] === right[i]) continue;
          if (left[i] != null) logTerminal("-" + left[i]);
          if (right[i] != null) logTerminal("+" + right[i]);
        }
      }

      function dragWindow(event, id) {
        if (event.button !== 0) return;
        focusWindow(id);
        const state = runtime.state.windows[id];
        state.maximized = false;
        delete state.restore;
        const start = { x: event.clientX, y: event.clientY, left: state.x, top: state.y };
        const move = (moveEvent) => {
          state.x = clamp(start.left + moveEvent.clientX - start.x, 0, Math.max(0, window.innerWidth - state.w));
          state.y = clamp(start.top + moveEvent.clientY - start.y, 0, Math.max(0, window.innerHeight - state.h - 38));
          const win = els.workspace.querySelector(`[data-app="${id}"]`);
          if (win) {
            win.style.left = state.x + "px";
            win.style.top = state.y + "px";
          }
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          persistHash();
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      }

      function appendResizeHandles(win, id) {
        ["n", "e", "s", "w", "ne", "nw", "se", "sw"].forEach((edge) => {
          const handle = document.createElement("span");
          handle.className = "resize-handle resize-" + edge;
          handle.addEventListener("pointerdown", (event) => resizeWindow(event, id, edge));
          win.appendChild(handle);
        });
      }

      function resizeWindow(event, id, edge) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        focusWindow(id);
        const state = runtime.state.windows[id];
        state.maximized = false;
        delete state.restore;
        const start = { x: event.clientX, y: event.clientY, left: state.x, top: state.y, w: state.w, h: state.h };
        const minW = 260;
        const minH = 180;
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - start.x;
          const dy = moveEvent.clientY - start.y;
          let x = start.left;
          let y = start.top;
          let w = start.w;
          let h = start.h;

          if (edge.includes("e")) w = clamp(start.w + dx, minW, Math.max(minW, window.innerWidth - x));
          if (edge.includes("s")) h = clamp(start.h + dy, minH, Math.max(minH, window.innerHeight - y - 38));
          if (edge.includes("w")) {
            const right = start.left + start.w;
            x = clamp(start.left + dx, 0, right - minW);
            w = right - x;
          }
          if (edge.includes("n")) {
            const bottom = start.top + start.h;
            y = clamp(start.top + dy, 0, bottom - minH);
            h = bottom - y;
          }

          Object.assign(state, { x, y, w, h });
          const win = els.workspace.querySelector(`[data-app="${id}"]`);
          if (win) {
            win.style.left = x + "px";
            win.style.top = y + "px";
            win.style.width = w + "px";
            win.style.height = h + "px";
          }
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          persistHash();
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      }

      function toggleMaximize(id) {
        const state = runtime.state.windows[id];
        if (!state) return;
        if (state.maximized && state.restore) {
          Object.assign(state, state.restore, { maximized: false });
          delete state.restore;
          return;
        }
        state.restore = { x: state.x, y: state.y, w: state.w, h: state.h };
        state.x = 0;
        state.y = 0;
        state.w = Math.max(260, els.workspace.clientWidth);
        state.h = Math.max(180, els.workspace.clientHeight);
        state.maximized = true;
        focusWindow(id);
      }

      function focusWindow(id) {
        if (id !== "terminal") runtime.focusOwner = "";
        const state = runtime.state.windows[id];
        if (!state || (state.z || 1) === runtime.state.z) return;
        runtime.state.z += 1;
        state.z = runtime.state.z;
        els.workspace.querySelectorAll(".window").forEach((win) => {
          const appId = win.dataset.app;
          const appState = runtime.state.windows[appId];
          win.style.zIndex = appState?.z || 1;
          win.dataset.focused = String(appId === id);
        });
      }

      function lightButton(kind, label) {
        const button = document.createElement("button");
        button.className = "light " + kind;
        button.title = label;
        button.setAttribute("aria-label", label);
        return button;
      }

      function meterRow(name, value) {
        const row = document.createElement("div");
        row.className = "meter-row";
        row.innerHTML = [
          `<span>${escapeHtml(name)}</span>`,
          `<span class="meter"><span style="width:${clamp(value, 0, 100)}%"></span></span>`,
          `<span>${Math.round(value)}%</span>`
        ].join("");
        return row;
      }

      function logTerminal(line) {
        runtime.state.terminal.push(String(line));
        runtime.state.terminal = runtime.state.terminal.slice(-160);
      }

      function toast(message) {
        clearTimeout(runtime.toastTimer);
        els.toast.textContent = message;
        els.toast.dataset.open = "true";
        runtime.toastTimer = setTimeout(() => {
          els.toast.dataset.open = "false";
        }, 2200);
      }

      function resetMachine() {
        Array.from(runtime.workers.keys()).forEach((pid) => stopWorkerProcess(pid, { quiet: true }));
        runtime.focusOwner = "";
        runtime.state = defaultState();
        runtime.processLog = [];
        runtime.meters = { cpu: 0, heap: 0, io: 0 };
        location.hash = "";
        render();
        toast("Machine reset");
      }

      function statusText() {
        const origin = location.protocol === "data:" ? "data: opaque origin" : location.protocol.replace(":", "") + " boot";
        const workerState = runtime.workers.size ? `${runtime.workers.size} process${runtime.workers.size === 1 ? "" : "es"}` : "idle";
        return `${origin} | ${Object.keys(runtime.state.files).length} files | ${workerState}`;
      }

      function osRelease(files) {
        const values = {
          NAME: "linkOS",
          VERSION: "0.0",
          ID: "linkos",
          PRETTY_NAME: "linkOS"
        };
        const text = files["/etc/linkos-release"] || "";
        text.split("\n").forEach((line) => {
          const match = line.match(/^([A-Z_]+)=(.*)$/);
          if (!match) return;
          values[match[1]] = match[2].replace(/^"|"$/g, "");
        });
        return {
          name: values.NAME,
          version: values.VERSION,
          id: values.ID,
          prettyName: values.PRETTY_NAME
        };
      }

      function splitArgs(value) {
        return value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) || [];
      }

      function normalizePath(path, base = runtime.state.cwd || "/") {
        const raw = (path || base).trim();
        const absolute = raw.startsWith("/") ? raw : `${base}/${raw}`;
        const parts = [];
        absolute.split("/").forEach((part) => {
          if (!part || part === ".") return;
          if (part === "..") parts.pop();
          else parts.push(part);
        });
        return "/" + parts.join("/");
      }

      function directoryExists(path) {
        const normalized = normalizePath(path);
        if (normalized === "/") return true;
        const prefix = normalized.endsWith("/") ? normalized : normalized + "/";
        return Object.keys(runtime.state.files).some((filePath) => filePath.startsWith(prefix));
      }

      function openDirectory(path) {
        runtime.state.fileManagerDir = normalizePath(path);
        runtime.state.windows.files.open = true;
        focusWindow("files");
        render();
      }

      function openVirtualFile(path) {
        const normalized = normalizePath(path);
        if (normalized.endsWith(".html") || normalized.endsWith(".htm")) {
          runtime.state.previewFile = normalized;
          runtime.state.windows.preview.open = true;
          focusWindow("preview");
          return;
        }
        runtime.state.activeFile = normalized;
        runtime.state.windows.editor.open = true;
        focusWindow("editor");
      }

      function directoryEntries(path) {
        const normalized = normalizePath(path);
        if (runtime.state.files[normalized] != null) {
          return [{
            name: normalized.split("/").pop(),
            path: normalized,
            type: "file",
            size: byteLength(runtime.state.files[normalized])
          }];
        }

        const prefix = normalized === "/" ? "/" : normalized + "/";
        const entries = new Map();
        if (normalized !== "/") {
          const parent = normalized.split("/").slice(0, -1).join("/") || "/";
          entries.set("../", { name: "../", path: parent, type: "dir", size: 0 });
        }
        Object.entries(runtime.state.files).forEach(([filePath, content]) => {
          if (!filePath.startsWith(prefix)) return;
          const rest = filePath.slice(prefix.length);
          if (!rest) return;
          const [name, ...tail] = rest.split("/");
          const childPath = prefix === "/" ? "/" + name : prefix + name;
          if (tail.length) {
            entries.set(name + "/", { name: name + "/", path: childPath, type: "dir", size: 0 });
          } else {
            entries.set(name, { name, path: childPath, type: "file", size: byteLength(content) });
          }
        });
        return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
      }

      function firstFileInDirectory(path) {
        return directoryEntries(path).find((entry) => entry.type === "file")?.path || null;
      }

      function byteLength(value) {
        return encoder.encode(String(value)).length;
      }

      function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " bytes";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1024 / 1024).toFixed(2) + " MB";
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[char]));
      }

      function cryptoRandomId() {
        const bytes = new Uint8Array(4);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
    })();
