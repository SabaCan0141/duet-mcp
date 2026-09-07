import { createRoot } from "react-dom/client";
import { useDoc, useEdit } from "duet-mcp/react";
import { defaultSettings, initialDoc, type Doc, type Settings } from "../doc";
import { EditActions } from "./edit-actions";
import { Canvas } from "./canvas";
import "./style.css";

function App() {
  const snap = useDoc<Doc>();
  const edit = useEdit<Settings>();
  const textEdit = useEdit<string>();
  if (!snap) return <main className="p-12 text-sm text-slate-500">Connecting to the studio…</main>;
  // Provide defaults for text-only snapshots. Save new fields through their operations.
  const saved = snap.doc.settings ?? defaultSettings();
  const settings = edit.active ? edit.value! : saved;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (!edit.active) edit.begin(snap, { ...saved });
    edit.setValue({ ...settings, [key]: value });
  };
  return <div id="studio" className="min-h-screen">
    <header className="border-b border-slate-200/80 bg-white">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-5 sm:px-10">
        <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-xl font-bold text-white">d.</span><span className="text-lg font-semibold tracking-tight">duet<span className="ml-3 border-l border-slate-200 pl-3 text-sm font-normal text-slate-400">playground</span></span></div>
        <div className="flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>Live<span className="hidden sm:inline"> · {snap.actor}</span></div>
      </div>
    </header>
    <main className="mx-auto max-w-[1440px] px-5 py-8 sm:px-10 sm:py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-[10px] font-bold tracking-[.2em] text-violet-600">YOUR SHARED CREATIVE SPACE</p><h1 className="text-3xl font-semibold tracking-tight">A little space for big ideas.</h1><p className="mt-3 text-sm text-slate-500">Tweak the controls. Move things around. One studio for you and AI.</p></div><span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">Studio / 01</span></div>
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <section className="panel" aria-label="Design settings">
          <div className="border-b border-slate-100 px-6 py-4"><h2 className="text-sm font-semibold">Design controls</h2><p className="mt-1 text-xs text-slate-400">Apply your settings to update the canvas.</p></div>
          <div className="space-y-5 p-6"><fieldset disabled={edit.pending} className="space-y-5">
            <label className="block"><span className="label">Heading</span><input className="field" maxLength={80} value={settings.caption} onChange={e=>set("caption",e.target.value)} /></label>
            <label className="block"><span className="label">Notes</span><textarea className="field min-h-20 resize-y" maxLength={500} value={settings.notes} onChange={e=>set("notes",e.target.value)} /></label>
            <div className="border-t border-slate-100 pt-5"><span className="label">Display options</span><div className="space-y-3 text-sm"><label className="flex items-center gap-2.5"><input type="checkbox" className="h-4 w-4" checked={settings.visible} onChange={e=>set("visible",e.target.checked)} />Show box</label><label className="flex items-center gap-2.5"><input type="checkbox" className="h-4 w-4" checked={settings.grid} onChange={e=>set("grid",e.target.checked)} />Dot grid</label></div></div>
            <fieldset><legend className="label">Style</legend><div className="grid grid-cols-2 gap-2">{([['solid','Solid'],['outline','Outline']] as const).map(([v,label])=><label key={v} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-xs ${settings.style===v?'border-violet-300 bg-violet-50 text-violet-700':'border-slate-200'}`}><input type="radio" name="style" value={v} checked={settings.style===v} onChange={()=>set("style",v)}/>{label}</label>)}</div></fieldset>
            <label className="block"><span className="label">Accent color</span><select className="field" value={settings.color} onChange={e=>set("color",e.target.value as Settings['color'])}><option value="violet">Violet</option><option value="blue">Blue</option><option value="coral">Coral</option></select></label>
            <label className="block"><span className="label flex justify-between">Opacity<span className="font-mono text-violet-600">{settings.opacity}%</span></span><input className="w-full" type="range" min={10} max={100} value={settings.opacity} onChange={e=>set("opacity",Number(e.target.value))}/></label>
          </fieldset><EditActions edit={edit} snap={snap} name="set_settings" args={v=>({...v})} current={JSON.stringify(saved)}/></div>
        </section>
        <div className="space-y-6"><Canvas snap={snap} settings={saved} box={snap.doc.box ?? initialDoc().box}/>
          <section className="panel p-6" aria-label="Shared note"><div className="mb-4 flex items-center gap-2"><span className="text-violet-500">✦</span><h2 className="text-sm font-semibold">Shared note</h2></div><p className="mb-4 whitespace-pre-wrap text-sm text-slate-500">{saved.notes}</p>
            <label htmlFor="text" className="label">Text</label><input id="text" className="field" placeholder="Leave a note for your collaborator…" disabled={textEdit.pending} value={textEdit.active?textEdit.value!:snap.doc.text} onChange={e=>{if(!textEdit.active)textEdit.begin(snap,snap.doc.text);textEdit.setValue(e.target.value);}} />
            <EditActions edit={textEdit} snap={snap} name="set_text" args={text=>({text})} current={snap.doc.text}/>
            <div id="shot" className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{snap.doc.text || "No notes yet."}</div>
          </section>
        </div>
      </div>
      <footer className="mt-8 flex flex-wrap justify-between gap-2 text-[11px] text-slate-400"><span>Made for two. Built with duet.</span><span>Changes are shared with everyone in this studio.</span></footer>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
