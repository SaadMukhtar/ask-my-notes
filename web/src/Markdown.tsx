import type { ReactNode } from "react";

/**
 * A deliberately tiny markdown renderer: headings, bullet/numbered lists, bold, inline code, and
 * [S#] citation chips. It builds React elements (never raw HTML), so text from notes or from the
 * model cannot inject markup or scripts into the page.
 */
export function Markdown({ text, onCite, known }: { text: string; onCite?: (id: string) => void; known?: Set<string> }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: ReactNode[] } | null = null;
  const flush = () => {
    if (!list) return;
    blocks.push(list.ordered ? <ol key={blocks.length}>{list.items}</ol> : <ul key={blocks.length}>{list.items}</ul>);
    list = null;
  };
  text.split("\n").forEach((line, i) => {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(<li key={i}>{inline((bullet ?? numbered)![1], onCite, known)}</li>);
      return;
    }
    flush();
    if (heading) blocks.push(<h4 key={i}>{inline(heading[2], onCite, known)}</h4>);
    else if (line.trim()) blocks.push(<p key={i}>{inline(line, onCite, known)}</p>);
  });
  flush();
  return <div className="md">{blocks}</div>;
}

function inline(text: string, onCite?: (id: string) => void, known?: Set<string>): ReactNode[] {
  return text.split(/(\[S\d+\]|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const cite = /^\[(S\d+)\]$/.exec(part);
    if (cite) {
      const ok = !known || known.has(cite[1]);
      return (
        <button key={i} className={`cite ${ok ? "" : "cite-bad"}`} onClick={() => onCite?.(cite[1])} title={ok ? "Show source" : "Unknown source"}>
          {cite[1].slice(1)}
        </button>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}
