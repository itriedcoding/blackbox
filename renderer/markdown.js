/* Small, dependency-free markdown renderer. Escapes HTML first, then formats.
   Deliberately limited to the subset a local chat model actually emits. */
(function () {
  "use strict";

  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return ESCAPES[character];
    });
  }

  function inline(text) {
    var out = escapeHtml(text);
    out = out.replace(/`([^`\n]+)`/g, function (_match, code) {
      return "<code>" + code + "</code>";
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_match, label, url) {
      return '<a href="' + url + '" rel="noreferrer noopener">' + label + "</a>";
    });
    return out;
  }

  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf("-") !== -1;
  }

  function splitRow(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map(function (cell) {
        return cell.trim();
      });
  }

  function renderBlocks(source, blocks) {
    var lines = String(source).replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var index = 0;

    while (index < lines.length) {
      var line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      var codeToken = /^\u0000CODE(\d+)\u0000$/.exec(line.trim());
      if (codeToken) {
        var block = blocks[Number(codeToken[1])];
        var language = block.lang ? ' data-lang="' + escapeHtml(block.lang) + '"' : "";
        html.push(
          "<pre" + language + "><code>" + escapeHtml(block.code.replace(/\n$/, "")) + "</code></pre>",
        );
        index += 1;
        continue;
      }

      var heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        var level = heading[1].length;
        html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        index += 1;
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        html.push("<hr />");
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        var quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        html.push("<blockquote>" + renderBlocks(quote.join("\n"), blocks) + "</blockquote>");
        continue;
      }

      if (/^\s*([-*+])\s+/.test(line)) {
        var items = [];
        while (index < lines.length && /^\s*([-*+])\s+/.test(lines[index])) {
          items.push(lines[index].replace(/^\s*([-*+])\s+/, ""));
          index += 1;
        }
        html.push(
          "<ul>" +
            items
              .map(function (item) {
                return "<li>" + inline(item) + "</li>";
              })
              .join("") +
            "</ul>",
        );
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ordered = [];
        while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
          ordered.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
          index += 1;
        }
        html.push(
          "<ol>" +
            ordered
              .map(function (item) {
                return "<li>" + inline(item) + "</li>";
              })
              .join("") +
            "</ol>",
        );
        continue;
      }

      if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        var header = splitRow(line);
        index += 2;
        var rows = [];
        while (index < lines.length && /^\s*\|/.test(lines[index])) {
          rows.push(splitRow(lines[index]));
          index += 1;
        }
        var table = "<table><thead><tr>";
        header.forEach(function (cell) {
          table += "<th>" + inline(cell) + "</th>";
        });
        table += "</tr></thead><tbody>";
        rows.forEach(function (row) {
          table += "<tr>";
          row.forEach(function (cell) {
            table += "<td>" + inline(cell) + "</td>";
          });
          table += "</tr>";
        });
        table += "</tbody></table>";
        html.push(table);
        continue;
      }

      var paragraph = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        !/^\u0000CODE\d+\u0000$/.test(lines[index].trim()) &&
        !/^(#{1,4})\s+/.test(lines[index]) &&
        !/^\s*([-*+])\s+/.test(lines[index]) &&
        !/^\s*\d+[.)]\s+/.test(lines[index]) &&
        !/^\s*>/.test(lines[index]) &&
        !/^\s*\|/.test(lines[index])
      ) {
        paragraph.push(lines[index]);
        index += 1;
      }
      html.push("<p>" + inline(paragraph.join("\n")).replace(/\n/g, "<br />") + "</p>");
    }

    return html.join("");
  }

  function renderThinking(text) {
    // Qwen3-style reasoning blocks become a collapsed <details> panel.
    var pattern = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi;
    var blocks = [];
    var replaced = text.replace(pattern, function (_match, inner) {
      blocks.push(inner.trim());
      return "\u0001THINK" + (blocks.length - 1) + "\u0001";
    });

    var rendered = render(replaced);
    blocks.forEach(function (block, index) {
      rendered = rendered.replace(
        "<p>\u0001THINK" + index + "\u0001</p>",
        '<details class="md__details"><summary>Reasoning</summary><div class="md__think">' +
          render(block) +
          "</div></details>",
      );
      rendered = rendered.replace(
        "\u0001THINK" + index + "\u0001",
        '<details class="md__details"><summary>Reasoning</summary><div class="md__think">' +
          render(block) +
          "</div></details>",
      );
    });
    return rendered;
  }

  function render(source) {
    var text = String(source == null ? "" : source);
    if (!text.trim()) return "";
    var blocks = [];
    var stripped = text.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, function (_match, lang, code) {
      blocks.push({ lang: lang || "", code: code });
      return "\u0000CODE" + (blocks.length - 1) + "\u0000";
    });
    return renderBlocks(stripped, blocks);
  }

  window.BlackboxMarkdown = {
    render: function (source) {
      return renderThinking(String(source == null ? "" : source));
    },
    escape: escapeHtml,
  };
})();
