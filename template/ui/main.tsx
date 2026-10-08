import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import type { ClientDoc } from "duet-mcp/react";
import { useDoc } from "../duet/browser";
import type { app, Doc } from "../app";
import "./style.css";

type Shared = ClientDoc<typeof app>;
type Box = Doc["box"];

function App() {
  // The shared state plus its actions. null until the first snapshot arrives.
  const doc = useDoc();
  if (!doc) return <p className="connecting">Connecting…</p>;
  return (
    <main id="app" className="page">
      <header>
        <h1 className="title">duet template<Version doc={doc} /></h1>
        <p className="lead">Use this page, or let an LLM call the same actions over MCP. Both edit one shared doc.</p>
      </header>
      <TextEditor doc={doc} />
      <BoxBoard doc={doc} />
      <History doc={doc} />
    </main>
  );
}

// The app version, read once through the GUI-only `version` action.
// Every runtime sharing the port runs the same version, so it never changes while the page is open.
function Version({ doc }: { doc: Shared }) {
  const [version, setVersion] = useState("");
  useEffect(() => { doc.version().then(setVersion, () => {}); }, []);
  return version ? <span className="version">v{version}</span> : null;
}

// Example 1: edit a local draft, then send it with Apply.
function TextEditor({ doc }: { doc: Shared }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false); // Blocks a second click before React re-renders.

  const apply = async () => {
    if (draft === null || sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      await doc.set_text({ text: draft });
      setDraft(null);
    } catch (error) {
      setError(String(error)); // Keep the draft so nothing is lost.
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <section aria-label="Text" className="card">
      <div className="card-head">
        <h2 className="card-title">Text</h2>
        <code className="action">set_text</code>
      </div>
      <div className="row">
        <input id="text" className="input" value={draft ?? doc.text} disabled={pending}
          onChange={(event) => setDraft(event.target.value)} />
        <button className="btn btn-primary" onClick={apply} disabled={draft === null || pending}>Apply</button>
        <button className="btn" onClick={() => setDraft(null)} disabled={draft === null || pending}>Cancel</button>
      </div>
      {error && <p role="alert" className="alert">{error}</p>}
      <p className="shared"><span className="shared-label">Shared</span><span id="shot" className="shared-value">{doc.text}</span></p>
    </section>
  );
}

// Example 2: while dragging only the screen moves; the doc is updated once, on release.
// The released position stays on screen until the doc shows it, so the box never jumps back.
const BOARD = { width: 400, height: 240, box: 80 }; // Matches the limits of move_box.
const clamp = (n: number, max: number) => Math.round(Math.min(max, Math.max(0, n)));

function BoxBoard({ doc }: { doc: Shared }) {
  const [dragged, setDragged] = useState<Box | null>(null); // Shown until the doc catches up.
  const drag = useRef<{ x: number; y: number; from: Box } | null>(null);
  const [error, setError] = useState("");
  const box = dragged ?? doc.box;

  // The update reaches useDoc() shortly after move_box is sent; switch back to the doc then.
  useEffect(() => { if (!drag.current) setDragged(null); }, [doc.box.x, doc.box.y]);

  // Position for the pointer, in board units (the board may be drawn smaller).
  const positionAt = (event: React.PointerEvent<HTMLElement>): Box => {
    const { x, y, from } = drag.current!;
    const scale = event.currentTarget.parentElement!.clientWidth / BOARD.width;
    return {
      x: clamp(from.x + (event.clientX - x) / scale, BOARD.width - BOARD.box),
      y: clamp(from.y + (event.clientY - y) / scale, BOARD.height - BOARD.box),
    };
  };

  const start = (event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: box };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    if (drag.current) setDragged(positionAt(event));
  };
  const release = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const position = positionAt(event);
    drag.current = null;
    setDragged(position);
    setError("");
    doc.move_box(position).catch(error => { setDragged(null); setError(String(error)); });
  };
  const cancel = () => {
    if (!drag.current) return; // lostpointercapture also fires right after a normal release.
    drag.current = null;
    setDragged(null);
  };

  return (
    <section aria-label="Box" className="card">
      <div className="card-head">
        <h2 className="card-title">Box</h2>
        <output className="coords">({box.x}, {box.y})</output>
        <code className="action">move_box</code>
      </div>
      <div className="board">
        <div aria-label="Draggable box" className="box"
          style={{ left: `${(box.x / BOARD.width) * 100}%`, top: `${(box.y / BOARD.height) * 100}%` }}
          onPointerDown={start} onPointerMove={move} onPointerUp={release}
          onPointerCancel={cancel} onLostPointerCapture={cancel} />
      </div>
      {error && <p role="alert" className="alert">{error}</p>}
    </section>
  );
}

// Example 3: undo/redo step the shared doc back and forth, whoever made the change.
// Buttons and Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z call the same actions.
function History({ doc }: { doc: Shared }) {
  const [error, setError] = useState("");
  const run = (step: () => Promise<boolean>) => {
    setError("");
    step().catch(error => setError(String(error)));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      if (event.target instanceof HTMLInputElement) return; // Leave text-field undo to the browser.
      event.preventDefault();
      run(() => event.shiftKey ? doc.redo() : doc.undo());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc]);

  return (
    <section aria-label="History" className="card">
      <div className="card-head">
        <h2 className="card-title">History</h2>
        <code className="action">undo / redo</code>
      </div>
      <div className="row">
        <button className="btn" onClick={() => run(() => doc.undo())}>Undo</button>
        <button className="btn" onClick={() => run(() => doc.redo())}>Redo</button>
      </div>
      {error && <p role="alert" className="alert">{error}</p>}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
