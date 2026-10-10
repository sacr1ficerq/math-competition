"use strict";

if (window.marked && window.katex && window.DOMPurify) {
  marked.use({ extensions: [{
    name: "math",
    level: "inline",
    start: (src) => src.search(/\$|\\\(|\\\[/),
    tokenizer(src) {
      for (const [open, close, display] of [["$$", "$$", true], ["\\[", "\\]", true], ["\\(", "\\)", false], ["$", "$", false]]) {
        if (!src.startsWith(open)) continue;
        let end = src.indexOf(close, open.length);
        while (end !== -1 && src[end - 1] === "\\") end = src.indexOf(close, end + close.length);
        if (end === -1) continue;
        const text = src.slice(open.length, end);
        if (!display && text.includes("\n")) continue;
        return { type: "math", raw: src.slice(0, end + close.length), text, display };
      }
    },
    renderer(token) {
      return katex.renderToString(token.text, { displayMode: token.display, throwOnError: false, trust: false, strict: "ignore" });
    },
  }] });
  window.renderMarkdown = (target, text) => {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text), { ADD_TAGS: ["annotation"], ADD_ATTR: ["encoding"] });
  };
}
