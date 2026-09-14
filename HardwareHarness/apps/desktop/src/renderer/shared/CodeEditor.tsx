import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "Geist Mono Variable, monospace" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--ring) 25%, transparent)" }
});

function language(path: string): Extension {
  if (path.endsWith(".py")) return python();
  if (/\.html?$/.test(path)) return html();
  if (/\.[cm]?[jt]sx?$/.test(path)) return javascript({ jsx: true, typescript: /\.tsx?$/.test(path) });
  if (path.endsWith(".css")) return css();
  if (path.endsWith(".json")) return json();
  return [];
}

export function CodeEditor({ path, value, onChange, onSave, readOnly = false, line }: {
  path: string; value: string; onChange: (value: string) => void; onSave: () => void; readOnly?: boolean; line?: number | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const external = useRef(false);
  const content = useRef(value);
  content.current = value;
  const mode = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: content.current, extensions: [
        lineNumbers(), search({ top: true }), highlightActiveLineGutter(), drawSelection(), history(), bracketMatching(), indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle), theme, language(path), mode.current.of(EditorState.readOnly.of(readOnly)),
        EditorView.contentAttributes.of({ "aria-label": `代码编辑器 ${path}` }),
        keymap.of([{ key: "Mod-s", run: () => { callbacks.current.onSave(); return true; } }, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => { if (update.docChanged && !external.current) callbacks.current.onChange(update.state.doc.toString()); })
      ] })
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, [path, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    external.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    external.current = false;
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !line) return;
    const target = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, line))).from;
    editor.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: "center" }) });
    editor.focus();
  }, [line, path]);

  return <div ref={host} className="h-full min-h-0 min-w-0 overflow-hidden" />;
}
