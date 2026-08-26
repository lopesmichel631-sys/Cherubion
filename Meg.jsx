import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import {
  Search,
  Plus,
  FileText,
  Link2,
  Menu,
  Download,
  Upload,
  Trash2,
  Share2,
  Workflow,
  Undo2,
  Redo2,
  Brackets,
  File,
  Tag,
  Paperclip,
  Heading,
  Bold,
  Italic,
  Keyboard,
  X,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  Pencil,
  Image as ImageIcon,
  Video as VideoIcon,
} from 'lucide-react';

// ---------- Helpers ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ambiente touch (celular/tablet)? Só nele faz sentido estimar a altura do teclado.
const EH_TOUCH =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0);

const extractWikilinks = (text) => {
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  const links = new Set();
  let m;
  while ((m = re.exec(text)) !== null) links.add(m[1].trim());
  return [...links];
};

// very small markdown renderer: headings, bold, italic, code, lists, wikilinks
function renderMarkdown(text, notesByTitle, onLinkClick) {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks = [];
  let listBuffer = [];

  const flushList = () => {
    if (listBuffer.length) {
      blocks.push(
        <ul key={'ul-' + blocks.length} className="ob-list">
          {listBuffer.map((item, i) => (
            <li key={i}>{inlineRender(item, notesByTitle, onLinkClick)}</li>
          ))}
        </ul>
      );
      listBuffer = [];
    }
  };

  lines.forEach((line, idx) => {
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      flushList();
      const level = h[1].length;
      const Tag = `h${Math.min(level, 6)}`;
      blocks.push(
        React.createElement(
          Tag,
          { key: idx, className: `ob-h ob-h${level}` },
          inlineRender(h[2], notesByTitle, onLinkClick)
        )
      );
      return;
    }
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      listBuffer.push(li[1]);
      return;
    }
    flushList();
    if (line.trim() === '') {
      blocks.push(<div key={idx} className="ob-spacer" />);
    } else {
      blocks.push(
        <p key={idx} className="ob-p">
          {inlineRender(line, notesByTitle, onLinkClick)}
        </p>
      );
    }
  });
  flushList();
  return blocks;
}

function inlineRender(text, notesByTitle, onLinkClick) {
  const parts = [];
  let remaining = text;
  let key = 0;
  const pattern = /(!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/;

  while (remaining.length) {
    const m = remaining.match(pattern);
    if (!m) {
      parts.push(remaining);
      break;
    }
    const idx = m.index;
    if (idx > 0) parts.push(remaining.slice(0, idx));

    if (m[2] !== undefined) {
      const targetTitle = m[2].trim();
      const label = m[3] || targetTitle;
      const ehEmbedMidia = m[0].startsWith('!') && /^(https?:|data:)/.test(targetTitle);
      if (ehEmbedMidia) {
        if (ehVideoUrl(targetTitle)) {
          parts.push(
            <video key={key++} src={targetTitle} controls playsInline className="ob-embed-video" />
          );
        } else {
          parts.push(
            <img key={key++} src={targetTitle} alt={label} className="ob-embed-img" />
          );
        }
      } else {
        const exists = !!notesByTitle[targetTitle.toLowerCase()];
        parts.push(
          <button
            key={key++}
            onClick={() => onLinkClick(targetTitle)}
            className={exists ? 'ob-wikilink' : 'ob-wikilink ob-wikilink-broken'}
            title={exists ? targetTitle : `Criar nota "${targetTitle}"`}
          >
            {label}
          </button>
        );
      }
    } else if (m[4] !== undefined) {
      parts.push(<strong key={key++}>{m[4]}</strong>);
    } else if (m[5] !== undefined) {
      parts.push(<em key={key++}>{m[5]}</em>);
    } else if (m[6] !== undefined) {
      parts.push(
        <code key={key++} className="ob-code">
          {m[6]}
        </code>
      );
    }
    remaining = remaining.slice(idx + m[0].length);
  }
  return parts;
}

// ---------- Graph helpers (shared by force graph + sankey) ----------
function buildGraphData(notes) {
  const notesArr = Object.values(notes);
  const idByTitle = {};
  notesArr.forEach((n) => {
    idByTitle[n.title.toLowerCase()] = n.id;
  });

  const outgoing = {};
  const incomingCount = {};
  const degree = {};
  notesArr.forEach((n) => {
    outgoing[n.id] = [];
    degree[n.id] = 0;
  });

  notesArr.forEach((n) => {
    const targets = extractWikilinks(n.content);
    targets.forEach((t) => {
      const targetId = idByTitle[t.toLowerCase()];
      if (targetId && targetId !== n.id) {
        outgoing[n.id].push(targetId);
        incomingCount[targetId] = (incomingCount[targetId] || 0) + 1;
        degree[n.id] += 1;
        degree[targetId] = (degree[targetId] || 0) + 1;
      }
    });
  });

  return { notesArr, idByTitle, outgoing, incomingCount, degree };
}

// ---------- Force-Directed Graph View ----------
function ForceGraphView({ notes, activeId, onSelectNote }) {
  const svgRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const { notesArr, outgoing, degree } = buildGraphData(notes);

    const nodes = notesArr.map((n) => ({ id: n.id, title: n.title }));
    const linkSet = new Set();
    const links = [];
    notesArr.forEach((n) => {
      (outgoing[n.id] || []).forEach((targetId) => {
        const key = [n.id, targetId].sort().join('::');
        if (!linkSet.has(key)) {
          linkSet.add(key);
          links.push({ source: n.id, target: targetId });
        }
      });
    });

    const width = containerRef.current?.clientWidth || 800;
    const height = containerRef.current?.clientHeight || 560;
    const radiusOf = (id) => 7 + Math.min(degree[id] || 0, 10) * 2.2;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);

    const g = svg.append('g');

    svg.call(
      d3
        .zoom()
        .scaleExtent([0.25, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        })
    );

    const linkSel = g
      .append('g')
      .attr('stroke', '#d6d6dd')
      .attr('stroke-width', 1.2)
      .selectAll('line')
      .data(links)
      .join('line');

    const nodeSel = g
      .append('g')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', (d) => radiusOf(d.id))
      .attr('fill', (d) =>
        d.id === activeId ? '#4b3ac2' : degree[d.id] ? '#7c6af2' : '#c9c9d1'
      )
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('click', (event, d) => onSelectNote(d.id));

    const labelSel = g
      .append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text((d) => d.title)
      .attr('font-size', 11)
      .attr('fill', '#3a3a42')
      .attr('text-anchor', 'middle')
      .style('pointer-events', 'none');

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(95)
          .strength(0.5)
      )
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force(
        'collide',
        d3.forceCollide((d) => radiusOf(d.id) + 8)
      );

    const dragBehavior = d3
      .drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeSel.call(dragBehavior);

    simulation.on('tick', () => {
      linkSel
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      nodeSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      labelSel.attr('x', (d) => d.x).attr('y', (d) => d.y - radiusOf(d.id) - 6);
    });

    return () => simulation.stop();
  }, [notes, activeId, onSelectNote]);

  return (
    <div ref={containerRef} className="ob-viz-container">
      <svg ref={svgRef} className="ob-viz-svg" />
      <div className="ob-viz-hint">Arraste os nós · Scroll para zoom · Clique para abrir a nota</div>
    </div>
  );
}

// ---------- Sankey-style Graph View ----------
function SankeyGraphView({ notes, activeId, onSelectNote }) {
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ width: 800, height: 560 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setDims({ width: el.clientWidth || 800, height: el.clientHeight || 560 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { columns, links, degree, maxDepth } = useMemo(() => {
    const { notesArr, outgoing, incomingCount, degree } = buildGraphData(notes);

    const depth = {};
    const roots = notesArr.filter((n) => !incomingCount[n.id]);
    const queue = [];
    (roots.length ? roots : notesArr).forEach((n) => {
      if (depth[n.id] === undefined) {
        depth[n.id] = 0;
        queue.push(n.id);
      }
    });

    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      (outgoing[cur] || []).forEach((t) => {
        if (depth[t] === undefined) {
          depth[t] = depth[cur] + 1;
          queue.push(t);
        }
      });
    }
    notesArr.forEach((n) => {
      if (depth[n.id] === undefined) depth[n.id] = 0;
    });

    const maxDepth = notesArr.length ? Math.max(...notesArr.map((n) => depth[n.id])) : 0;
    const cols = Array.from({ length: maxDepth + 1 }, () => []);
    notesArr.forEach((n) => cols[depth[n.id]].push(n));

    const linksArr = [];
    notesArr.forEach((n) => {
      (outgoing[n.id] || []).forEach((t) => {
        linksArr.push({ sourceId: n.id, targetId: t });
      });
    });

    return { columns: cols, links: linksArr, degree, maxDepth };
  }, [notes]);

  const { width, height } = dims;
  const colWidth = maxDepth > 0 ? width / (maxDepth + 1) : width;
  const nodeWidth = 14;

  const positions = useMemo(() => {
    const pos = {};
    const usableHeight = Math.max(height - 40, 100);
    const gap = 10;
    columns.forEach((col, ci) => {
      const rawHeights = col.map((n) =>
        Math.max(18, Math.min(64, 14 + (degree[n.id] || 0) * 8))
      );
      const totalRaw =
        rawHeights.reduce((a, b) => a + b, 0) + gap * Math.max(0, col.length - 1);
      const scale = totalRaw > usableHeight && totalRaw > 0 ? usableHeight / totalRaw : 1;
      let y = 20;
      col.forEach((n, i) => {
        const h = rawHeights[i] * scale;
        pos[n.id] = {
          x: ci * colWidth + colWidth / 2 - nodeWidth / 2,
          y,
          height: h,
        };
        y += h + gap * scale;
      });
    });
    return pos;
  }, [columns, colWidth, height, degree]);

  const linkPath = (l) => {
    const s = positions[l.sourceId];
    const t = positions[l.targetId];
    if (!s || !t) return '';
    const sx = s.x + nodeWidth;
    const sy = s.y + s.height / 2;
    const tx = t.x;
    const ty = t.y + t.height / 2;
    const mx = (sx + tx) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
  };

  const allNotes = Object.values(notes);

  return (
    <div ref={containerRef} className="ob-viz-container">
      <svg width={width} height={height} className="ob-viz-svg">
        <g>
          {links.map((l, i) => (
            <path key={i} d={linkPath(l)} className="ob-sankey-link" />
          ))}
        </g>
        <g>
          {allNotes.map((n) => {
            const p = positions[n.id];
            if (!p) return null;
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                className="ob-sankey-node-group"
                onClick={() => onSelectNote(n.id)}
              >
                <rect
                  width={nodeWidth}
                  height={p.height}
                  rx={3}
                  className={
                    n.id === activeId
                      ? 'ob-sankey-node ob-sankey-node-active'
                      : 'ob-sankey-node'
                  }
                />
                <text x={nodeWidth + 6} y={p.height / 2} dy="0.32em" className="ob-sankey-label">
                  {n.title}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="ob-viz-hint">
        Colunas = distância a partir das notas raiz (sem links de entrada) · Clique para abrir
      </div>
    </div>
  );
}

// ---------- Persistência (técnica do Cherubion) ----------
// Espelho direto no localStorage real do navegador. É a rede de segurança: no preview
// o window.storage às vezes falha de forma intermitente; quando isso acontece,
// gravamos aqui e os dados ficam a salvo do mesmo jeito.
const lsSet = (chave, valor) => {
  try { window.localStorage.setItem('meg-fallback:' + chave, valor); return true; }
  catch (e) { return false; }
};
const lsGet = (chave) => {
  try { return window.localStorage.getItem('meg-fallback:' + chave); }
  catch (e) { return null; }
};

const storageExiste = () =>
  typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function';

// ---------- Upload de mídia via Cloudflare R2 (Worker compartilhado com o Minha Tela) ----------
// URL do Worker e token ficam no localStorage real do navegador, FORA do backup em JSON —
// são credencial de dispositivo, compartilhada entre os apps do mesmo GitHub Pages (mesma
// origem), não dado do usuário.
const lerConfigR2 = () => {
  try {
    return {
      url: (window.localStorage.getItem('cherubion:r2workerurl') || '').replace(/\/+$/, ''),
      token: window.localStorage.getItem('cherubion:r2token') || '',
    };
  } catch (e) {
    return { url: '', token: '' };
  }
};

// só para imagens — reduz para no máx. 1280px de largura, JPEG 75% (corta boa parte do
// tamanho sem perda visual perceptível numa tela de celular). Vídeo não passa por isso.
const comprimirImagemParaUpload = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const objUrl = URL.createObjectURL(file);
  img.onload = () => {
    const MAX_LARGURA = 1280;
    let { width, height } = img;
    if (width > MAX_LARGURA) { height = Math.round(height * (MAX_LARGURA / width)); width = MAX_LARGURA; }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(objUrl);
      if (blob) resolve(blob); else reject(new Error('falha ao comprimir a imagem'));
    }, 'image/jpeg', 0.75);
  };
  img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('falha ao carregar a imagem')); };
  img.src = objUrl;
});

const subirArquivoParaR2 = async (blob, nomeOriginal) => {
  const { url, token } = lerConfigR2();
  if (!url || !token) throw new Error('sem-config');
  const ext = (String(nomeOriginal || '').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const nomeArquivo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const resp = await fetch(`${url}/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Filename': nomeArquivo,
    },
    body: blob,
  });
  if (!resp.ok) throw new Error(`upload falhou (${resp.status})`);
  const dados = await resp.json();
  if (!dados || !dados.url) throw new Error('resposta do Worker sem url');
  return dados.url;
};

// heurística simples pra saber se uma URL/data-URI de embed é vídeo, pra escolher entre
// renderizar <img> ou <video> no modo Visualizar
const ehVideoUrl = (url) =>
  /^data:video\//.test(url) || /\.(mp4|webm|mov|m4v|ogg)(\?.*)?(#.*)?$/i.test(url);

// tenta salvar no window.storage com retry; sempre espelha no localStorage
const tentarSalvarComRetry = async (chave, valor, retries = 1) => {
  try {
    const res = await window.storage.set(chave, valor);
    lsSet(chave, valor); // espelha sempre que o window.storage funciona
    return res;
  } catch (e) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 700));
      return tentarSalvarComRetry(chave, valor, retries - 1);
    }
    throw e;
  }
};

// ---------- Live Preview (formatação enquanto digita) ----------
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// transforma o texto cru em HTML formatado. Os marcadores (**, [[, #, etc.) são mantidos
// no DOM (para o mapeamento 1:1 do cursor) mas ficam OCULTOS via CSS.
//
// IMPORTANTE: este HTML NÃO depende da posição do cursor. Cada token ganha data-ini/
// data-fim (offsets no texto cru) e quem decide o que revelar é `aplicarRevelacao`,
// que só liga/desliga uma CLASSE. Motivo: reconstruir o innerHTML destrói os nós de
// texto e obriga a recriar a seleção por código — e no iOS um caret recriado assim
// muitas vezes simplesmente não aparece. Era exatamente por isso que tocar na tela
// "às vezes funcionava, às vezes não". Trocando classe, os nós sobrevivem e o caret
// nativo do toque continua de pé.
const TOKEN_MD = /(!?\[\[[^\]\n]*\]\]|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

function highlightMarkdown(text) {
  const render = (s, base) => {
    let out = '';
    let ultimo = 0;
    let m;
    TOKEN_MD.lastIndex = 0;
    while ((m = TOKEN_MD.exec(s)) !== null) {
      out += escapeHtml(s.slice(ultimo, m.index));
      const bruto = m[0];
      let open, close, cls;
      if (bruto.startsWith('![[')) { open = '![['; close = ']]'; cls = 'lp-embed'; }
      else if (bruto.startsWith('[[')) { open = '[['; close = ']]'; cls = 'lp-link'; }
      else if (bruto.startsWith('**')) { open = '**'; close = '**'; cls = 'lp-b'; }
      else if (bruto.startsWith('`')) { open = '`'; close = '`'; cls = 'lp-code'; }
      else { open = '*'; close = '*'; cls = 'lp-i'; }

      const ini = base + m.index;
      const fim = ini + bruto.length;
      const conteudoBruto = bruto.slice(open.length, bruto.length - close.length);
      const conteudo = escapeHtml(conteudoBruto);

      // embed de mídia (imagem/vídeo): mostra a miniatura de verdade em vez do
      // texto cru. O texto (marcadores + URL) só reaparece quando o cursor está
      // dentro deste token — igual ao Obsidian, que esconde a sintaxe e revela a
      // mídia. Não muda o mapeamento de offsets: <img>/<video> não são nós de
      // texto, então não contam para o textContent nem para o TreeWalker.
      const ehEmbedMidia = cls === 'lp-embed' && /^(https?:|data:)/.test(conteudoBruto.trim());
      if (ehEmbedMidia) {
        const urlAlvo = conteudoBruto.trim();
        const tagMidia = ehVideoUrl(urlAlvo)
          ? `<video src="${escapeHtml(urlAlvo)}" class="ob-embed-video lp-embed-media" controls playsInline contenteditable="false"></video>`
          : `<img src="${escapeHtml(urlAlvo)}" class="ob-embed-img lp-embed-media" contenteditable="false" alt="" />`;
        out +=
          `<span class="${cls}" data-ini="${ini}" data-fim="${fim}">` +
          `<span class="lp-m">${escapeHtml(open)}</span>` +
          `<span class="lp-embed-src">${conteudo}</span>` +
          tagMidia +
          `<span class="lp-m">${escapeHtml(close)}</span>` +
          `</span>`;
      } else {
        out +=
          `<span class="${cls}" data-ini="${ini}" data-fim="${fim}">` +
          `<span class="lp-m">${escapeHtml(open)}</span>` +
          conteudo +
          `<span class="lp-m">${escapeHtml(close)}</span>` +
          `</span>`;
      }
      ultimo = m.index + bruto.length;
    }
    out += escapeHtml(s.slice(ultimo));
    return out;
  };

  let offset = 0; // início absoluto da linha corrente
  return (
    text
      .split('\n')
      .map((line) => {
        const inicioLinha = offset;
        offset += line.length + 1; // +1 pelo '\n' que o split consumiu
        const h = line.match(/^(#{1,6})\s/);
        if (h) {
          // o "# " do título segue a regra da LINHA (é o que o Obsidian faz): some
          // quando o cursor está em outra linha, aparece quando você está editando esta
          const marcador = escapeHtml(line.slice(0, h[0].length));
          const resto = render(line.slice(h[0].length), inicioLinha + h[0].length);
          return (
            `<span class="lp-h lp-h${h[1].length}" data-ini="${inicioLinha}" data-fim="${inicioLinha + line.length}">` +
            `<span class="lp-m">${marcador}</span>${resto}</span>`
          );
        }
        return render(line, inicioLinha);
      })
      .join('\n') +
    // sentinela: sem um elemento focável, o navegador se recusa a colocar o cursor na
    // ÚLTIMA linha quando ela está vazia (e acaba digitando antes do \n anterior). Só é
    // preciso quando o texto termina em \n; caso contrário criaria uma linha fantasma.
    (text.endsWith('\n') ? '<br>' : '')
  );
}

// Revela/esconde os marcadores conforme a posição do cursor — SEM tocar na estrutura
// do DOM (só na classe). Os nós de texto permanecem os mesmos, então o caret nativo
// criado pelo toque do usuário continua válido e visível.
function aplicarRevelacao(root, cursor) {
  if (!root) return;
  root.querySelectorAll('[data-ini]').forEach((el) => {
    const ini = +el.dataset.ini;
    const fim = +el.dataset.fim;
    const dentro = cursor >= ini && cursor <= fim;
    // classe no próprio token: usada pelos embeds de mídia para trocar entre
    // mostrar a miniatura (padrão) e mostrar o texto cru (enquanto o cursor
    // estiver dentro do link, para permitir editá-lo)
    el.classList.toggle('lp-revelado', dentro);
    // só os marcadores DIRETOS deste trecho: um título pode conter links aninhados,
    // que têm o próprio data-ini e são tratados na sua própria volta do laço
    el.querySelectorAll(':scope > .lp-m').forEach((mk) => {
      mk.classList.toggle('lp-m-show', dentro);
    });
  });
}

// extrai o título-alvo do texto bruto de um span .lp-link/.lp-embed já renderizado
// (ex.: "[[Título#âncora|Apelido]]" ou "![[Título]]" -> "Título")
function extrairAlvoDoLink(textoBruto) {
  const m = (textoBruto || '').match(/\[\[([^\]|#]+)/);
  return m ? m[1].trim() : null;
}

// posição da seleção em nº de caracteres a partir do início do editor
function obterOffsets(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return [0, 0];
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  // ATENÇÃO: range.toString() IGNORA texto com display:none — e os marcadores de
  // markdown das linhas não ativas ficam exatamente assim (classe .lp-m). Medir com
  // toString() encurtava o offset sempre que havia um marcador oculto antes do cursor,
  // e a seleção era restaurada no lugar errado (o famoso "cursor pulando").
  // cloneContents().textContent conta TODO o texto, oculto ou não — simétrico ao
  // definirSelecao, que também anda por textContent.
  const start = pre.cloneContents().textContent.length;
  const len = range.cloneContents().textContent.length;
  return [start, start + len];
}

// posiciona a seleção no editor a partir de offsets em nº de caracteres
function definirSelecao(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode = null, startOff = 0, endNode = null, endOff = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (!startNode && pos + len >= start) {
      startNode = node;
      startOff = start - pos;
    }
    if (!endNode && pos + len >= end) {
      endNode = node;
      endOff = end - pos;
      break;
    }
    pos += len;
  }
  const sel = window.getSelection();
  const range = document.createRange();
  if (!startNode) {
    // editor vazio ou offset além do fim: cursor no final
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.setStart(startNode, Math.min(startOff, startNode.textContent.length));
    range.setEnd(endNode || startNode, Math.min(endOff || startOff, (endNode || startNode).textContent.length));
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---------- Proteção contra tela branca ----------
// Se QUALQUER erro estourar durante a renderização, em vez de o app sumir numa tela
// em branco, mostramos o erro por extenso — o que transforma "não abre" em algo
// diagnosticável na hora.
class LimiteDeErro extends React.Component {
  constructor(props) {
    super(props);
    this.state = { erro: null };
  }
  static getDerivedStateFromError(erro) {
    return { erro };
  }
  render() {
    if (this.state.erro) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', color: '#c0362c', background: '#fff', minHeight: '100vh' }}>
          <h2 style={{ marginTop: 0 }}>O Meg encontrou um erro</h2>
          <p>Seus dados estão salvos. Copie a mensagem abaixo e envie para o desenvolvedor:</p>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#fbe4e2', padding: 12, borderRadius: 8 }}>
            {String((this.state.erro && this.state.erro.stack) || this.state.erro)}
          </pre>
          <button
            onClick={() => this.setState({ erro: null })}
            style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: '#7c6af2', color: '#fff', fontSize: 14 }}
          >
            Tentar de novo
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------- Main App ----------
function MegApp() {
  const [notes, setNotes] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [abas, setAbas] = useState([]); // ids das notas abertas em aba, na ordem
  const [seletorAbas, setSeletorAbas] = useState(false); // painel com todas as abas abertas
  const [nav, setNav] = useState({ pilha: [], indice: -1 }); // histórico de navegação (voltar/avançar)
  const tabsRef = useRef(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('edit'); // 'edit' | 'preview'
  const [mainView, setMainView] = useState('notes'); // 'notes' | 'graph' | 'sankey'
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 700
  );
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState('');
  const [saveStatus, setSaveStatus] = useState(''); // '' | 'saving' | 'saved' | 'error'
  const fileInputRef = useRef(null);
  const imagemInputRef = useRef(null); // input escondido: anexar imagem (upload R2)
  const videoInputRef = useRef(null); // input escondido: anexar vídeo (upload R2)
  const [enviandoMidia, setEnviandoMidia] = useState(false);
  const textareaRef = useRef(null); // agora aponta para o editor contentEditable
  const historicoRef = useRef({}); // { [noteId]: { passado: [], futuro: [], ignorarProximo, ultimoRegistro } }
  const pendingSelRef = useRef(null); // [ini, fim] a restaurar após o próximo re-render do editor
  const ultimaSelRef = useRef([0, 0]); // fonte de verdade da posição p/ os botões da barra
  const selCongeladaRef = useRef(false); // true entre o toque na barra e a próxima interação no editor
  const selAnuladaRef = useRef(false); // vimos a seleção ser ANULADA sem interação no editor desde então
  const sincronizandoRef = useRef(false); // ignora selectionchange gerados pelo nosso próprio innerHTML
  const posCursorRef = useRef(-1); // offset do cursor: só o token sob ele mostra marcadores.
  // É ref, não estado: mover o cursor não deve re-renderizar o React nem reconstruir o editor.
  const [editorFocado, setEditorFocado] = useState(false); // barra inferior só aparece ao escrever
  const [menuTitulo, setMenuTitulo] = useState(false); // popover de escolha do nível do título
  const snapToqueRef = useRef(null); // seleção capturada no touchstart da barra
  const [barY, setBarY] = useState(null); // Y da barra = fundo da área visível - altura da barra
  const [folgaFinal, setFolgaFinal] = useState(0); // altura do vazio no fim da nota (só o necessário)
  const barRef = useRef(null);
  const mainRef = useRef(null); // .ob-main — âncora estável da barra (não rola)

  // ref espelhando o estado para o loop de medição (que roda uma vez só)
  const editorFocadoRef = useRef(false);
  useEffect(() => {
    editorFocadoRef.current = editorFocado;
  }, [editorFocado]);

  // o contador de abas ocupa o canto inferior quando o teclado está fechado; o loop
  // de medição precisa saber disso para não deixar a barra em cima dele
  const contadorNaTelaRef = useRef(false);
  useEffect(() => {
    contadorNaTelaRef.current = mainView === 'notes' && abas.length > 0 && !editorFocado;
  }, [mainView, abas.length, editorFocado]);

  // ---- Gesto de lateral (estilo Obsidian mobile) ----
  // arrastar da borda esquerda para a direita ABRE o painel; arrastar para a
  // esquerda em qualquer lugar FECHA. Ignora arrastes verticais (scroll) e a
  // barra de ferramentas (que tem scroll horizontal próprio).
  const sidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  useEffect(() => {
    let x0 = 0;
    let y0 = 0;
    let ativo = false;
    let decidido = false;
    const onTouchStart = (e) => {
      const alvo = e.target;
      if (alvo && alvo.closest && alvo.closest('.ob-toolbar')) {
        ativo = false;
        return;
      }
      const t = e.touches[0];
      x0 = t.clientX;
      y0 = t.clientY;
      decidido = false;
      // fechado: só rastreia se o toque começou na borda esquerda (32px)
      // aberto: rastreia em qualquer lugar (para o arraste de fechar)
      ativo = sidebarOpenRef.current || t.clientX <= 32;
    };
    const onTouchMove = (e) => {
      if (!ativo || decidido) return;
      const t = e.touches[0];
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) {
        ativo = false; // é scroll vertical, não gesto de lateral
        return;
      }
      if (dx > 50 && !sidebarOpenRef.current) {
        decidido = true;
        setSidebarOpen(true);
      } else if (dx < -50 && sidebarOpenRef.current) {
        decidido = true;
        setSidebarOpen(false);
      }
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // Loop de requestAnimationFrame: a cada frame calcula onde termina a área VISÍVEL
  // (acima do teclado) e prende a barra ali — como no Obsidian mobile.
  //
  // POR QUE NÃO position:fixed? Dentro de um iframe no iOS (o caso do preview),
  // fixed é tratado como absolute e a barra "rola junto" com o conteúdo — que é
  // exatamente o defeito relatado. A solução clássica é ancorar a barra com
  // position:absolute num contêiner que NÃO rola (.ob-main) e recalcular o top a
  // cada frame a partir de getBoundingClientRect(), que já desconta sozinho
  // qualquer rolagem que o sistema faça para revelar o cursor.
  //
  // Altura do teclado: no app/navegador real o visualViewport dá o valor exato.
  // No iframe ele nunca enxerga o teclado — aí, em aparelho touch com o editor
  // focado, estimamos ~42% da altura da tela (faixa típica de teclado de celular).
  // setState com valor idêntico não re-renderiza, então o custo do loop é desprezível.
  const FOLGA_BARRA = 6; // respiro entre a barra e o topo do teclado
  // O iOS desenha uma barra própria (as setas ^ v e o ✓) logo acima do teclado quando
  // o foco está num campo dentro de um web view / iframe. Ela NÃO entra em nenhuma
  // medição disponível para nós, então precisa ser descontada à mão — senão a nossa
  // barra fica exatamente atrás dela.
  const ALTURA_BARRA_IOS = 52;
  // altura reservada no rodapé para o quadradinho com o número de abas
  const ALTURA_CONTADOR = 52;
  useEffect(() => {
    let ativo = true;
    const passo = () => {
      if (!ativo) return;
      const main = mainRef.current;
      const bar = barRef.current;
      if (!main || !bar) {
        // sem barra na tela (modo visualizar / grafos): nada a medir neste frame
        requestAnimationFrame(passo);
        return;
      }
      const vv = window.visualViewport;
      const alturaBar = bar.offsetHeight || 52;
      const alturaJanela = window.innerHeight;

      const tecladoReal = vv
        ? Math.max(0, alturaJanela - vv.height - vv.offsetTop)
        : 0;
      const temTecladoReal = tecladoReal > 60;
      const tecladoEstimado =
        !temTecladoReal && EH_TOUCH && editorFocadoRef.current
          ? Math.round(alturaJanela * 0.42) + ALTURA_BARRA_IOS
          : 0;

      // fundo da área visível, em coordenadas do VIEWPORT
      const fundoVisivel = temTecladoReal
        ? vv.offsetTop + vv.height
        : (vv ? vv.offsetTop + vv.height : alturaJanela) - tecladoEstimado;

      // converte para coordenadas LOCAIS do .ob-main (âncora absolute da barra).
      // O getBoundingClientRect já reflete qualquer scroll da página, então a
      // barra fica cravada na tela mesmo que o iOS empurre o documento.
      const mainTop = main.getBoundingClientRect().top;
      // com o teclado fechado, o quadradinho de abas ocupa o rodapé: a barra sobe
      // o suficiente para ficar acima dele, em vez de cobri-lo
      const zonaContador = contadorNaTelaRef.current ? ALTURA_CONTADOR : 0;
      const topLocal = fundoVisivel - mainTop - alturaBar - FOLGA_BARRA - zonaContador;

      setBarY(Math.max(0, Math.round(topLocal)));

      // Folga no fim da nota = exatamente o que está tapando o conteúdo
      // (teclado, quando aberto + a própria barra). Sem teclado sobram só uns
      // ~70px — nada do vazio enorme de antes.
      const obstrucao = Math.round(
        alturaJanela - fundoVisivel + alturaBar + 16 + zonaContador
      );
      setFolgaFinal(Math.max(0, obstrucao));

      requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
    return () => {
      ativo = false;
    };
  }, []);

  // "Chave de revelação": identifica QUAL trecho deve mostrar seus marcadores para uma
  // dada posição de cursor — o token de markdown sob o cursor (se houver) e a linha
  // (que importa para o "# " de título). Re-renderizamos o editor apenas quando esta
  // chave muda; mover o cursor dentro do mesmo trecho não mexe no DOM.
  const chaveRevelacao = (texto, i) => {
    const linha = texto.slice(0, i).split('\n').length - 1;
    const inicioLinha = texto.lastIndexOf('\n', i - 1) + 1;
    const idxFim = texto.indexOf('\n', inicioLinha);
    const linhaTxt = texto.slice(inicioLinha, idxFim === -1 ? texto.length : idxFim);
    let chave = `L${linha}`;
    TOKEN_MD.lastIndex = 0;
    let m;
    while ((m = TOKEN_MD.exec(linhaTxt)) !== null) {
      const ini = inicioLinha + m.index;
      const fim = ini + m[0].length;
      if (i >= ini && i <= fim) {
        chave += `:T${ini}-${fim}`;
        break;
      }
    }
    return chave;
  };

  const chaveRevelacaoRef = useRef('');

  // trocar de nota zera o rastreio: offsets da nota anterior não valem para a nova
  useEffect(() => {
    posCursorRef.current = -1;
    chaveRevelacaoRef.current = '';
  }, [activeId]);

  // registra a posição do cursor e atualiza os marcadores visíveis, por classe
  // `aplicar=false` nos caminhos de digitação: ali o texto mudou, o efeito de
  // sincronização vai reconstruir o HTML e já reaplica a revelação — fazer isso
  // aqui também seria um reflow a mais dentro do manipulador do evento.
  const registrarCursor = (texto, i, aplicar = true) => {
    chaveRevelacaoRef.current = chaveRevelacao(texto, i);
    posCursorRef.current = i;
    if (aplicar) aplicarRevelacao(textareaRef.current, i);
  };

  // Recalcula onde o cursor está e atualiza o trecho revelado — SEMPRE no frame
  // seguinte, nunca dentro do próprio manipulador do toque.
  //
  // POR QUE ADIADO: mostrar/esconder marcadores muda `display` e provoca um reflow.
  // Feito de forma síncrona durante o clique, o WebKit descarta o caret que estava
  // acabando de posicionar — e o toque "não faz nada". Era o sintoma de tocar no
  // texto e o cursor não aparecer, enquanto tocar num link (que retorna antes desta
  // função) continuava funcionando. Esperar um frame deixa o navegador terminar de
  // colocar o caret primeiro; só então mexemos nas classes.
  const revelacaoAgendadaRef = useRef(0);
  const atualizarLinhaAtiva = () => {
    if (revelacaoAgendadaRef.current) return; // já há uma atualização a caminho
    revelacaoAgendadaRef.current = requestAnimationFrame(() => {
      revelacaoAgendadaRef.current = 0;
      if (sincronizandoRef.current) return; // no meio do nosso próprio reset do DOM
      const el = textareaRef.current;
      if (!el || !activeId) return;
      // sem uma seleção real DENTRO do editor não há o que medir: qualquer leitura
      // aqui seria o [0,0] falso que jogava o cursor para o topo
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      if (!el.contains(sel.getRangeAt(0).startContainer)) return;
      const texto = notes[activeId]?.content ?? '';
      const [i] = obterOffsets(el);
      if (chaveRevelacao(texto, i) === chaveRevelacaoRef.current) return;
      // nada no DOM é destruído — só classes mudam — então o caret que o toque
      // criou continua exatamente onde está, sem precisar ser recriado por código
      registrarCursor(texto, i);
    });
  };

  // cancela uma revelação pendente ao desmontar / trocar de nota
  useEffect(() => {
    return () => {
      if (revelacaoAgendadaRef.current) {
        cancelAnimationFrame(revelacaoAgendadaRef.current);
        revelacaoAgendadaRef.current = 0;
      }
    };
  }, [activeId]);

  // A posição usada pelos botões da barra NÃO é a seleção viva do navegador — é a
  // memória ultimaSelRef, alimentada por este listener. Motivo (comprovado em teste):
  // ao tocar num botão, o iOS/WebKit às vezes ANULA a seleção do contentEditable e
  // logo em seguida RECRIA um cursor recolhido no TOPO do texto. Esse caret fantasma
  // parece legítimo (rangeCount > 0, dentro do editor), e era ele que mandava a
  // edição — e o cursor — para o início. Duas regras o filtram:
  //  1. congelada: entre o pointerdown na barra e a próxima interação real no editor,
  //     nenhum caret recolhido é aceito (um range de verdade, arrastado pelo usuário,
  //     continua sendo aceito);
  //  2. anulada: um caret recolhido que chega logo depois de a seleção ter sido
  //     anulada, sem interação no editor no meio, é o engine recriando sozinho —
  //     um caret colocado pelo usuário nunca passa por esse estado nulo antes.
  useEffect(() => {
    const aoMudarSelecao = () => {
      if (sincronizandoRef.current) return; // mudança causada pelo nosso próprio reset
      const el = textareaRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) {
        selAnuladaRef.current = true;
        return;
      }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) {
        selAnuladaRef.current = true;
        return;
      }
      if (range.collapsed && (selAnuladaRef.current || selCongeladaRef.current)) return;
      ultimaSelRef.current = obterOffsets(el);
    };
    document.addEventListener('selectionchange', aoMudarSelecao);
    return () => document.removeEventListener('selectionchange', aoMudarSelecao);
  }, []);

  // interação real com o editor: volta a confiar em carets recolhidos
  const confiarNaSelecao = () => {
    selCongeladaRef.current = false;
    selAnuladaRef.current = false;
  };

  // sincroniza o editor live-preview: re-renderiza o HTML formatado quando o conteúdo muda
  // e restaura a posição do cursor mapeada por offset de caracteres
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || mode !== 'edit') return;
    sincronizandoRef.current = true;
    const conteudo = (activeId && notes[activeId]?.content) || '';
    const html = highlightMarkdown(conteudo);
    let houveReset = false;
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      houveReset = true;
      // o HTML novo vem com todos os marcadores ocultos: reaplica o trecho revelado
      aplicarRevelacao(el, posCursorRef.current);
    }
    if (pendingSelRef.current) {
      const [i, f] = pendingSelRef.current;
      pendingSelRef.current = null;
      // preventScroll é essencial: focus() sem ele "revela" o elemento focado
      // rolando até o TOPO dele — e como o editor é a nota inteira, a página
      // saltava para o começo a cada edição pela barra.
      el.focus({ preventScroll: true });
      definirSelecao(el, i, f);
      ultimaSelRef.current = [i, f]; // a restauração É a nova verdade
      // garante que o cursor restaurado esteja visível, rolando o MÍNIMO necessário
      const area = el.closest('.ob-editor-area');
      const sel = window.getSelection();
      if (area && sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(false);
        let rect = r.getClientRects()[0] || r.getBoundingClientRect();
        if (!rect || (rect.top === 0 && rect.height === 0)) {
          const nodo = r.startContainer;
          const elBase = nodo.nodeType === 1 ? nodo : nodo.parentElement;
          if (elBase) rect = elBase.getBoundingClientRect();
        }
        if (rect) {
          const areaRect = area.getBoundingClientRect();
          const margem = 80; // não deixa o cursor colado nas bordas nem sob a barra
          if (rect.top < areaRect.top + margem) {
            area.scrollTop -= areaRect.top + margem - rect.top;
          } else if (rect.bottom > areaRect.bottom - margem) {
            area.scrollTop += rect.bottom - (areaRect.bottom - margem);
          }
        }
      }
    } else if (houveReset && document.activeElement === el) {
      // o reset do innerHTML destruiu a seleção sem uma restauração pendente:
      // recoloca onde estava, senão o engine recria um caret fantasma no topo
      definirSelecao(el, ultimaSelRef.current[0], ultimaSelRef.current[1]);
    }
    setTimeout(() => {
      sincronizandoRef.current = false;
    }, 0);
  });

  // ---- Load from storage ----
  useEffect(() => {
    (async () => {
      try {
        let valorSalvo = null;
        if (storageExiste()) {
          try {
            const result = await window.storage.get('notes-store');
            if (result && result.value) valorSalvo = result.value;
          } catch (err) {
            valorSalvo = null; // se window.storage falhar na leitura, tentamos o fallback abaixo
          }
        }
        // se o window.storage não trouxe nada, tenta o espelho no localStorage real
        if (!valorSalvo) valorSalvo = lsGet('notes-store');
        let parsed = null;
        try {
          parsed = valorSalvo ? JSON.parse(valorSalvo) : null;
        } catch (err) {
          console.error('Dados salvos ilegíveis', err);
          parsed = null;
        }
        if (parsed && parsed.notes && Object.keys(parsed.notes).length) {
          setNotes(parsed.notes);
          const savedActive = parsed.activeId;
          const ativa =
            savedActive && parsed.notes[savedActive]
              ? savedActive
              : Object.keys(parsed.notes)[0];
          setActiveId(ativa);
          // restaura as abas, descartando ids de notas que já não existem
          const salvas = Array.isArray(parsed.abas)
            ? parsed.abas.filter((id) => parsed.notes[id])
            : [];
          setAbas(salvas.includes(ativa) ? salvas : [...salvas, ativa]);
        } else {
          // seed with a welcome note
          const id = uid();
          const id2 = uid();
          const welcome = {
            id,
            title: 'Bem-vindo',
            content:
              '# Bem-vindo ao seu cofre\n\nEsta é uma réplica personalizável de um app de notas estilo Obsidian.\n\n- Use `[[Nome da Nota]]` para criar links entre notas\n- Use **negrito**, *itálico* e `código`\n- Crie novas notas com o botão "+"\n- Veja o [[Grafo]] das suas notas\n\nExperimente criar um link para [[Minhas Ideias]].',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const graphNote = {
            id: id2,
            title: 'Grafo',
            content:
              '# Grafo\n\nEsta nota existe só para demonstrar os links. Volte para [[Bem-vindo]] quando quiser.',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          setNotes({ [id]: welcome, [id2]: graphNote });
          setActiveId(id);
          setAbas([id]);
        }
      } catch (e) {
        console.error('Erro ao carregar notas', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // ---- Persist to storage (debounced-ish via effect) ----
  useEffect(() => {
    if (!loaded) return;
    // safety: never overwrite saved notes with an empty state
    if (Object.keys(notes).length === 0) return;
    setSaveStatus('saving');
    const t = setTimeout(async () => {
      const dados = JSON.stringify({ notes, activeId, abas });
      try {
        if (!storageExiste()) throw new Error('window.storage indisponível');
        const res = await tentarSalvarComRetry('notes-store', dados);
        setSaveStatus(res ? 'saved' : 'error');
      } catch (e) {
        // window.storage falhou (comum no preview). Grava no localStorage real:
        // os dados ficam salvos e não mostramos alarme falso.
        const salvouLocal = lsSet('notes-store', dados);
        if (salvouLocal) {
          setSaveStatus('saved');
        } else {
          console.error('Erro ao salvar', e);
          setSaveStatus('error');
        }
      }
    }, 400);
    return () => clearTimeout(t);
  }, [notes, activeId, abas, loaded]);

  // ---- Save immediately when the tab is closed / hidden ----
  useEffect(() => {
    if (!loaded) return;
    const flush = () => {
      if (Object.keys(notes).length === 0) return;
      const dados = JSON.stringify({ notes, activeId, abas });
      lsSet('notes-store', dados); // localStorage é síncrono — garante o save mesmo fechando
      try {
        if (storageExiste()) window.storage.set('notes-store', dados);
      } catch (e) { /* localStorage já salvou */ }
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [notes, activeId, abas, loaded]);

  const notesByTitle = useMemo(() => {
    const map = {};
    Object.values(notes).forEach((n) => {
      map[n.title.toLowerCase()] = n;
    });
    return map;
  }, [notes]);

  const noteList = useMemo(() => {
    const arr = Object.values(notes);
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query.trim()) return arr;
    const q = query.toLowerCase();
    return arr.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q)
    );
  }, [notes, query]);

  const activeNote = activeId ? notes[activeId] : null;

  const backlinks = useMemo(() => {
    if (!activeNote) return [];
    return Object.values(notes).filter((n) => {
      if (n.id === activeNote.id) return false;
      const links = extractWikilinks(n.content).map((l) => l.toLowerCase());
      return links.includes(activeNote.title.toLowerCase());
    });
  }, [notes, activeNote]);

  // Histórico de navegação entre notas, ao estilo "voltar/avançar" de navegador. Toda
  // vez que o usuário abre uma nota por intenção própria (clicar num [[link]], numa
  // aba, na lista lateral, num backlink, ou no grafo), ela entra nesta pilha. Se o
  // usuário estava no meio do histórico e navega para um lugar novo, tudo que estava
  // "à frente" é descartado — igual ao comportamento de um navegador de verdade.
  const navegarParaNota = useCallback((id) => {
    if (!id) return;
    setActiveId(id);
    setNav((prev) => {
      if (prev.pilha[prev.indice] === id) return prev; // já estamos nela, nada a empilhar
      const cortada = prev.pilha.slice(0, prev.indice + 1);
      const nova = [...cortada, id];
      return { pilha: nova, indice: nova.length - 1 };
    });
  }, []);

  const podeVoltar = nav.indice > 0;
  const podeAvancar = nav.indice >= 0 && nav.indice < nav.pilha.length - 1;

  // "voltar" e "avançar" só ANDAM na pilha existente — nunca empilham nada de novo,
  // senão o avançar ficaria impossível depois de um voltar (o próprio ato de mostrar
  // a nota anterior apagaria o "futuro" que estamos tentando alcançar).
  const voltarNavegacao = useCallback(() => {
    setNav((prev) => {
      if (prev.indice <= 0) return prev;
      const novoIndice = prev.indice - 1;
      const id = prev.pilha[novoIndice];
      if (notes[id]) {
        setActiveId(id);
        setAbas((abasPrev) => (abasPrev.includes(id) ? abasPrev : [...abasPrev, id]));
        setMainView('notes');
      }
      return { ...prev, indice: novoIndice };
    });
  }, [notes]);

  const avancarNavegacao = useCallback(() => {
    setNav((prev) => {
      if (prev.indice >= prev.pilha.length - 1) return prev;
      const novoIndice = prev.indice + 1;
      const id = prev.pilha[novoIndice];
      if (notes[id]) {
        setActiveId(id);
        setAbas((abasPrev) => (abasPrev.includes(id) ? abasPrev : [...abasPrev, id]));
        setMainView('notes');
      }
      return { ...prev, indice: novoIndice };
    });
  }, [notes]);

  // semeia a pilha com a primeira nota assim que o carregamento termina
  useEffect(() => {
    if (loaded && activeId && nav.pilha.length === 0) {
      setNav({ pilha: [activeId], indice: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, activeId]);

  // abre a nota numa aba: se já estiver aberta só troca de aba, senão cria uma nova
  // logo depois da aba atual (como o Obsidian, que não joga a nova para o fim)
  const abrirEmAba = useCallback((id) => {
    if (!id) return;
    setAbas((prev) => {
      if (prev.includes(id)) return prev;
      const pos = prev.indexOf(activeId);
      if (pos === -1) return [...prev, id];
      return [...prev.slice(0, pos + 1), id, ...prev.slice(pos + 1)];
    });
    navegarParaNota(id);
    setMainView('notes');
  }, [activeId, navegarParaNota]);

  // fecha todas as abas exceto a primeira. IMPORTANTE: só fecha abas — as notas
  // continuam existindo e acessíveis pela lista lateral.
  const fecharOutrasAbas = () => {
    if (abas.length <= 1) return;
    const primeira = abas[0];
    setAbas([primeira]);
    setActiveId(primeira);
  };

  // fecha uma aba e escolhe a vizinha como ativa (a da direita; se não houver, a da esquerda)
  const fecharAba = (id) => {
    const idx = abas.indexOf(id);
    const restantes = abas.filter((x) => x !== id);
    setAbas(restantes);
    if (id === activeId) {
      setActiveId(restantes[idx] ?? restantes[idx - 1] ?? null);
    }
  };

  // mantém a aba ativa visível, rolando SÓ a faixa de abas (nunca a página)
  useEffect(() => {
    const cont = tabsRef.current;
    if (!cont) return;
    const el = cont.querySelector('.ob-tab-ativa');
    if (!el) return;
    const c = cont.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < c.left) cont.scrollLeft -= c.left - r.left + 8;
    else if (r.right > c.right) cont.scrollLeft += r.right - c.right + 8;
  }, [activeId, abas]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  };

  const createNote = useCallback(
    (titleGuess) => {
      const id = uid();
      let title = (titleGuess || 'Nova nota').trim();
      // avoid duplicate titles
      let finalTitle = title;
      let counter = 2;
      while (notesByTitle[finalTitle.toLowerCase()]) {
        finalTitle = `${title} ${counter++}`;
      }
      const n = {
        id,
        title: finalTitle,
        content: `# ${finalTitle}\n\n`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setNotes((prev) => ({ ...prev, [id]: n }));
      setAbas((prev) => {
        const pos = prev.indexOf(activeId);
        return pos === -1 ? [...prev, id] : [...prev.slice(0, pos + 1), id, ...prev.slice(pos + 1)];
      });
      setActiveId(id);
      setMode('edit');
      setMainView('notes');
      return id;
    },
    [notesByTitle, activeId]
  );

  const updateActiveContent = (content) => {
    if (!activeId) return;
    setNotes((prev) => ({
      ...prev,
      [activeId]: { ...prev[activeId], content, updatedAt: Date.now() },
    }));
  };

  // ---- barra de ferramentas do editor ----
  // registra o valor atual na pilha de "desfazer" antes de uma nova edição do usuário
  const editarConteudo = (novoConteudo) => {
    if (!activeId) return;
    const pilha =
      historicoRef.current[activeId] ||
      (historicoRef.current[activeId] = { passado: [], futuro: [], ignorarProximo: false, ultimoRegistro: 0 });
    if (pilha.ignorarProximo) {
      // esta mudança veio de um desfazer/refazer — não empilha de novo
      pilha.ignorarProximo = false;
    } else {
      const anterior = notes[activeId]?.content ?? '';
      const agora = Date.now();
      // agrupa digitação rápida: só cria um novo ponto de desfazer a cada ~500ms
      if (agora - pilha.ultimoRegistro > 500) {
        pilha.passado = [...pilha.passado, anterior].slice(-100); // limita a 100 níveis
        pilha.futuro = [];
        pilha.ultimoRegistro = agora;
      }
    }
    updateActiveContent(novoConteudo);
  };

  // aplica uma transformação ao texto na seleção/cursor atual do editor, e reposiciona o cursor
  const aplicarNoTextarea = (transform) => {
    const el = textareaRef.current;
    if (!el || !activeId) return;
    const texto = notes[activeId]?.content ?? '';
    // a seleção viva é apenas visual. Fonte preferida: o snapshot do touchstart
    // (capturado antes de o iOS processar o toque); senão, a memória.
    const snap = snapToqueRef.current;
    const usarSnap = snap && Date.now() - snap.t < 3000;
    const [ini, fim] = usarSnap ? snap.sel : ultimaSelRef.current;
    snapToqueRef.current = null;
    const selecionado = texto.slice(ini, fim);
    const { novoTexto, selIni, selFim } = transform(texto, ini, fim, selecionado);
    pendingSelRef.current = [selIni, selFim];
    editarConteudo(novoTexto);
  };

  // envolve a seleção com marcadores (ex: **negrito**). Se nada estiver selecionado,
  // insere os marcadores e deixa o cursor no meio.
  const envolver = (antes, depois = antes, placeholder = '') =>
    aplicarNoTextarea((texto, ini, fim, sel) => {
      const conteudo = sel || placeholder;
      const novoTexto = texto.slice(0, ini) + antes + conteudo + depois + texto.slice(fim);
      const selIni = ini + antes.length;
      const selFim = selIni + conteudo.length;
      return { novoTexto, selIni, selFim };
    });

  // insere um texto na posição do cursor (sem envolver seleção) — usado para colar o
  // embed `![[url]]` depois que o upload de imagem/vídeo termina
  const inserirTexto = (texto) =>
    aplicarNoTextarea((textoAtual, ini, fim) => {
      const novoTexto = textoAtual.slice(0, ini) + texto + textoAtual.slice(fim);
      const pos = ini + texto.length;
      return { novoTexto, selIni: pos, selFim: pos };
    });

  // Anexa uma imagem: comprime e sobe pro R2 se o Worker estiver configurado; senão cai
  // de volta pro embed em base64 (nunca trava o fluxo por falta de configuração).
  const anexarImagem = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setEnviandoMidia(true);
    showToast('Enviando imagem...');
    try {
      const { url, token } = lerConfigR2();
      if (url && token) {
        let blobFinal = file;
        try {
          blobFinal = await comprimirImagemParaUpload(file);
        } catch (err) {
          blobFinal = file; // se a compressão falhar, sobe o arquivo original
        }
        const urlFinal = await subirArquivoParaR2(blobFinal, file.name);
        inserirTexto(`![[${urlFinal}]]`);
      } else {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = () => reject(new Error('falha ao ler o arquivo'));
          reader.readAsDataURL(file);
        });
        inserirTexto(`![[${dataUrl}]]`);
      }
    } catch (err) {
      console.error('Erro ao anexar imagem', err);
      showToast('Erro ao enviar imagem');
    } finally {
      setEnviandoMidia(false);
    }
  };

  // Anexa um vídeo: exige o Worker configurado (arquivo grande demais pra base64)
  const anexarVideo = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const { url, token } = lerConfigR2();
    if (!url || !token) {
      showToast('Configure o servidor de mídia para anexar vídeos');
      return;
    }
    setEnviandoMidia(true);
    showToast('Enviando vídeo...');
    try {
      const urlFinal = await subirArquivoParaR2(file, file.name);
      inserirTexto(`![[${urlFinal}]]`);
    } catch (err) {
      console.error('Erro ao anexar vídeo', err);
      showToast('Erro ao enviar vídeo');
    } finally {
      setEnviandoMidia(false);
    }
  };

  // define o nível do título da linha atual (0 = texto normal). Troca o marcador que já
  // existe em vez de empilhar outro — por isso aplicar duas vezes nunca vira "# # texto".
  const definirTitulo = (nivel) =>
    aplicarNoTextarea((texto, ini, fim) => {
      const inicioLinha = texto.lastIndexOf('\n', ini - 1) + 1;
      const fimLinha = texto.indexOf('\n', inicioLinha) === -1 ? texto.length : texto.indexOf('\n', inicioLinha);
      const linha = texto.slice(inicioLinha, fimLinha);
      const atual = linha.match(/^(#{1,6})\s+/); // marcador já presente, se houver
      const semMarcador = atual ? linha.slice(atual[0].length) : linha;
      const novoMarcador = nivel > 0 ? '#'.repeat(nivel) + ' ' : '';
      const novaLinha = novoMarcador + semMarcador;
      const novoTexto = texto.slice(0, inicioLinha) + novaLinha + texto.slice(fimLinha);
      // o cursor anda junto com a diferença de tamanho do marcador
      const desloc = novoMarcador.length - (atual ? atual[0].length : 0);
      const min = inicioLinha + novoMarcador.length;
      return {
        novoTexto,
        selIni: Math.max(min, ini + desloc),
        selFim: Math.max(min, fim + desloc),
      };
    });

  // nível do título da linha onde o cursor está — para destacar a opção ativa no menu.
  // Usa a mesma fonte dos botões (última seleção conhecida), então continua certo
  // mesmo se o iOS tiver descartado a seleção viva ao abrir o menu.
  const nivelTituloAtual = (() => {
    if (!activeId) return 0;
    const texto = notes[activeId]?.content ?? '';
    const [ini] = ultimaSelRef.current;
    const inicioLinha = texto.lastIndexOf('\n', ini - 1) + 1;
    const idxFim = texto.indexOf('\n', inicioLinha);
    const linha = texto.slice(inicioLinha, idxFim === -1 ? texto.length : idxFim);
    const m = linha.match(/^(#{1,6})\s+/);
    return m ? m[1].length : 0;
  })();

  const desfazer = () => {
    if (!activeId) return;
    const pilha = historicoRef.current[activeId];
    if (!pilha || pilha.passado.length === 0) return;
    const atual = notes[activeId]?.content ?? '';
    const anterior = pilha.passado[pilha.passado.length - 1];
    pilha.passado = pilha.passado.slice(0, -1);
    pilha.futuro = [atual, ...pilha.futuro];
    pilha.ignorarProximo = true; // não registra esta mudança como nova edição
    updateActiveContent(anterior);
  };
  const refazer = () => {
    if (!activeId) return;
    const pilha = historicoRef.current[activeId];
    if (!pilha || pilha.futuro.length === 0) return;
    const atual = notes[activeId]?.content ?? '';
    const proximo = pilha.futuro[0];
    pilha.futuro = pilha.futuro.slice(1);
    pilha.passado = [...pilha.passado, atual];
    pilha.ignorarProximo = true;
    updateActiveContent(proximo);
  };

  const updateActiveTitle = (title) => {
    if (!activeId) return;
    setNotes((prev) => ({
      ...prev,
      [activeId]: { ...prev[activeId], title, updatedAt: Date.now() },
    }));
  };

  const deleteNote = (id) => {
    delete historicoRef.current[id]; // libera a pilha de desfazer da nota excluída
    const idx = abas.indexOf(id);
    const abasRestantes = abas.filter((x) => x !== id);
    setAbas(abasRestantes);
    setNotes((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    if (activeId === id) {
      // prefere a aba vizinha; se não sobrou nenhuma aba, cai em qualquer nota restante
      const vizinha = abasRestantes[idx] ?? abasRestantes[idx - 1] ?? null;
      setActiveId(vizinha ?? Object.keys(notes).find((k) => k !== id) ?? null);
    }
  };

  // Abrir uma nota NÃO muda o modo. Como no Obsidian, você segue no Live Preview
  // (editável) ao seguir um link — antes o app caía em "Visualizar" aqui, e por isso
  // depois do primeiro link só dava para clicar em links: o texto virava somente-leitura.
  const handleLinkClick = (title) => {
    const existing = notesByTitle[title.toLowerCase()];
    if (existing) {
      abrirEmAba(existing.id);
    } else {
      createNote(title);
    }
  };

  // o menu de títulos não deve sobreviver a uma troca de nota ou de modo
  useEffect(() => {
    setMenuTitulo(false);
  }, [activeId, mode, mainView]);

  // o seletor não deve continuar aberto depois de sair das notas
  useEffect(() => {
    if (mainView !== 'notes') setSeletorAbas(false);
  }, [mainView]);

  // prévia curta do conteúdo, sem os marcadores de markdown, para os cartões do seletor
  const previaDoTexto = (texto = '') =>
    texto
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (m, alvo, rotulo) => rotulo || alvo)
      .replace(/[*`]/g, '')
      .replace(/^\s*[-+]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);

  const handleSelectFromViz = useCallback(
    (id) => {
      abrirEmAba(id);
    },
    [abrirEmAba]
  );

  const exportBackup = () => {
    const data = JSON.stringify({ notes, activeId }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cofre-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exportado!');
  };

  // aceita só o formato esperado e descarta campos estranhos — assim um arquivo
  // malformado (ou adulterado) não consegue injetar dados fora do modelo de nota
  const sanitizarNotas = (bruto) => {
    if (!bruto || typeof bruto !== 'object') return null;
    const limpas = {};
    Object.values(bruto).forEach((n) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.content !== 'string') return;
      limpas[n.id] = {
        id: n.id,
        title: n.title.slice(0, 300),
        content: n.content,
        createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
        updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.now(),
      };
    });
    return Object.keys(limpas).length ? limpas : null;
  };

  const importBackup = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const limpas = sanitizarNotas(parsed && parsed.notes);
        if (limpas) {
          setNotes(limpas);
          const ativa =
            parsed.activeId && limpas[parsed.activeId]
              ? parsed.activeId
              : Object.keys(limpas)[0];
          setActiveId(ativa);
          setAbas([ativa]);
          showToast('Backup importado!');
        } else {
          showToast('Arquivo de backup inválido');
        }
      } catch (err) {
        showToast('Erro ao importar arquivo');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  if (!loaded) {
    return (
      <div className="ob-root ob-loading">
        <div className="ob-spinner" />
      </div>
    );
  }

  return (
    <div className="ob-root">
      <style>{CSS}</style>

      {/* alça na borda esquerda: qualquer toque/clique na lateral abre o painel */}
      {!sidebarOpen && (
        <button
          className="ob-edge-zone"
          onClick={() => setSidebarOpen(true)}
          aria-label="Abrir painel lateral"
          title="Abrir painel lateral"
        >
          <span className="ob-edge-grip" />
        </button>
      )}

      {/* fundo escurecido (só em telas estreitas): tocar fora fecha o painel */}
      {sidebarOpen && (
        <div className="ob-backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`ob-sidebar ${sidebarOpen ? '' : 'ob-sidebar-collapsed'}`}>
        <div className="ob-sidebar-header">
          <span className="ob-brand">📓 Cofre</span>
          <button
            className="ob-icon-btn"
            onClick={() => {
              createNote();
              if (window.innerWidth <= 700) setSidebarOpen(false);
            }}
            title="Nova nota"
          >
            <Plus size={18} />
          </button>
        </div>

        <div className="ob-search">
          <Search size={14} className="ob-search-icon" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar notas..."
          />
        </div>

        <div className="ob-note-list">
          {noteList.length === 0 && (
            <div className="ob-empty">Nenhuma nota encontrada</div>
          )}
          {noteList.map((n) => (
            <div
              key={n.id}
              className={`ob-note-item ${n.id === activeId && mainView === 'notes' ? 'ob-note-item-active' : ''}`}
              onClick={() => {
                abrirEmAba(n.id);
                if (window.innerWidth <= 700) setSidebarOpen(false);
              }}
            >
              <FileText size={14} className="ob-note-item-icon" />
              <span className="ob-note-item-title">{n.title}</span>
              <button
                className="ob-note-item-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Excluir "${n.title}"?`)) deleteNote(n.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="ob-sidebar-footer">
          <button className="ob-footer-btn" onClick={exportBackup}>
            <Download size={13} /> Exportar
          </button>
          <button className="ob-footer-btn" onClick={() => fileInputRef.current.click()}>
            <Upload size={13} /> Importar
          </button>
          <input
            type="file"
            accept="application/json"
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={importBackup}
          />
        </div>
      </div>

      {/* Main content */}
      <div className="ob-main" ref={mainRef}>
        <div className="ob-topbar">
          <button
            className="ob-icon-btn"
            style={{ fontSize: 16 }}
            onClick={() => { window.location.href = 'index.html'; }}
            title="Voltar ao Minha Tela"
            aria-label="Voltar ao Minha Tela"
          >🏠</button>
          <button
            className="ob-icon-btn"
            style={{ fontSize: 16 }}
            onClick={() => { window.location.href = 'contatos.html'; }}
            title="Baralho de Contatos"
            aria-label="Abrir o Baralho de Contatos"
          >📇</button>
          <button className="ob-icon-btn" onClick={() => setSidebarOpen((s) => !s)}>
            <Menu size={18} />
          </button>

          <button
            className="ob-icon-btn"
            onClick={voltarNavegacao}
            disabled={!podeVoltar}
            title="Nota anterior"
            aria-label="Nota anterior"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="ob-icon-btn"
            onClick={avancarNavegacao}
            disabled={!podeAvancar}
            title="Próxima nota"
            aria-label="Próxima nota"
          >
            <ChevronRight size={18} />
          </button>

          <div className="ob-view-tabs">
            <button
              className={mainView === 'notes' ? 'ob-view-tab ob-view-tab-active' : 'ob-view-tab'}
              onClick={() => setMainView('notes')}
            >
              <FileText size={14} /> Notas
            </button>
            <button
              className={mainView === 'graph' ? 'ob-view-tab ob-view-tab-active' : 'ob-view-tab'}
              onClick={() => setMainView('graph')}
            >
              <Share2 size={14} /> Grafo
            </button>
            <button
              className={mainView === 'sankey' ? 'ob-view-tab ob-view-tab-active' : 'ob-view-tab'}
              onClick={() => setMainView('sankey')}
            >
              <Workflow size={14} /> Sankey
            </button>
          </div>

          {saveStatus && (
            <span className={`ob-save-status ob-save-${saveStatus}`}>
              {saveStatus === 'saving' && 'Salvando...'}
              {saveStatus === 'saved' && 'Salvo ✓'}
              {saveStatus === 'error' && 'Erro ao salvar!'}
            </span>
          )}

          {mainView === 'notes' && activeNote && (
            <button
              className="ob-mode-single"
              onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
              title={mode === 'edit' ? 'Ver formatado' : 'Voltar a editar'}
            >
              {mode === 'edit' ? (
                <><BookOpen size={15} /> Visualizar</>
              ) : (
                <><Pencil size={15} /> Editar</>
              )}
            </button>
          )}
          {mainView !== 'notes' && <div className="ob-mode-toggle-spacer" />}
        </div>

        {/* faixa de abas: uma por nota aberta, rolável na horizontal */}
        {mainView === 'notes' && abas.length > 0 && (
          <div className="ob-tabs" ref={tabsRef}>
            {abas.map((id) => {
              const n = notes[id];
              if (!n) return null;
              return (
                <div
                  key={id}
                  className={id === activeId ? 'ob-tab ob-tab-ativa' : 'ob-tab'}
                  onClick={() => navegarParaNota(id)}
                  title={n.title}
                >
                  <FileText size={12} className="ob-tab-icone" />
                  <span className="ob-tab-titulo">{n.title}</span>
                  <button
                    className="ob-tab-fechar"
                    aria-label={`Fechar ${n.title}`}
                    onClick={(e) => {
                      e.stopPropagation(); // não trocar de aba ao fechar
                      fecharAba(id);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            <button className="ob-tab-nova" onClick={() => createNote()} title="Nova nota">
              <Plus size={14} />
            </button>
          </div>
        )}

        {mainView === 'graph' && (
          <ForceGraphView notes={notes} activeId={activeId} onSelectNote={handleSelectFromViz} />
        )}

        {mainView === 'sankey' && (
          <SankeyGraphView notes={notes} activeId={activeId} onSelectNote={handleSelectFromViz} />
        )}

        {mainView === 'notes' && (
          !activeNote ? (
            <div className="ob-no-note">
              <FileText size={40} strokeWidth={1} />
              <p>Selecione ou crie uma nota para começar</p>
              <button className="ob-primary-btn" onClick={() => createNote()}>
                <Plus size={16} /> Nova nota
              </button>
            </div>
          ) : (
            <div className="ob-editor-area">
              <input
                className="ob-title-input"
                value={activeNote.title}
                onChange={(e) => updateActiveTitle(e.target.value)}
                placeholder="Título da nota"
              />

              {mode === 'edit' ? (
                <>
                  <div
                    ref={textareaRef}
                    className="ob-liveeditor"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    onPointerDown={confiarNaSelecao}
                    onInput={(e) => {
                      confiarNaSelecao();
                      const el = e.currentTarget;
                      const [i, f] = obterOffsets(el);
                      pendingSelRef.current = [i, f];
                      const novoTexto = el.textContent;
                      registrarCursor(novoTexto, i, false);
                      editarConteudo(novoTexto);
                    }}
                    onKeyUp={atualizarLinhaAtiva}
                    onClick={(e) => {
                      // tocar num [[link]] ou ![[embed]] renderizado navega para a nota,
                      // mesmo enquanto você digita em outro ponto da mesma linha.
                      // A única exceção é o link em que o cursor JÁ está: ele está aberto
                      // em modo fonte (marcadores visíveis) justamente para ser editado,
                      // então ali o toque só posiciona o cursor.
                      const alvoEl = e.target.closest && e.target.closest('.lp-link, .lp-embed');
                      const ehMidiaEmbed = alvoEl && alvoEl.querySelector('.lp-embed-media');
                      const emEdicao = alvoEl && alvoEl.querySelector('.lp-m-show');
                      if (alvoEl && !emEdicao && !ehMidiaEmbed) {
                        const alvo = extrairAlvoDoLink(alvoEl.textContent);
                        if (alvo) {
                          handleLinkClick(alvo);
                          return;
                        }
                      }
                      atualizarLinhaAtiva();
                    }}
                    onFocus={() => { setEditorFocado(true); atualizarLinhaAtiva(); }}
                    onBlur={() => setTimeout(() => setEditorFocado(false), 150)}
                    onKeyDown={(e) => {
                      confiarNaSelecao();
                      if (e.key === 'Enter') {
                        // Insere um nó de texto '\n' REAL direto no DOM (não <br>, que o
                        // textContent ignora; não execCommand, obsoleto). Mutar o DOM aqui
                        // e já mesmo é o que evita a corrida: quando o onInput do próximo
                        // caractere ler el.textContent, a quebra já estará lá.
                        e.preventDefault();
                        const el = e.currentTarget;
                        const sel = window.getSelection();
                        if (!sel || sel.rangeCount === 0) return;
                        const range = sel.getRangeAt(0);
                        range.deleteContents();
                        const tn = document.createTextNode('\n');
                        range.insertNode(tn);
                        range.setStartAfter(tn);
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        const [i] = obterOffsets(el);
                        const novoTexto = el.textContent;
                        pendingSelRef.current = [i, i];
                        registrarCursor(novoTexto, i, false);
                        editarConteudo(novoTexto);
                      }
                    }}
                    onPaste={(e) => {
                      // cola como texto puro, inserindo nó de texto real no DOM
                      e.preventDefault();
                      const el = e.currentTarget;
                      const colado = (e.clipboardData || window.clipboardData).getData('text/plain');
                      if (!colado) return;
                      const sel = window.getSelection();
                      if (!sel || sel.rangeCount === 0) return;
                      const range = sel.getRangeAt(0);
                      range.deleteContents();
                      const tn = document.createTextNode(colado);
                      range.insertNode(tn);
                      range.setStartAfter(tn);
                      range.collapse(true);
                      sel.removeAllRanges();
                      sel.addRange(range);
                      const [i] = obterOffsets(el);
                      const novoTexto = el.textContent;
                      pendingSelRef.current = [i, i];
                      registrarCursor(novoTexto, i, false);
                      editarConteudo(novoTexto);
                    }}
                  />
                </>
              ) : (
                <div className="ob-preview">
                  {renderMarkdown(activeNote.content, notesByTitle, handleLinkClick)}
                </div>
              )}

              {backlinks.length > 0 && (
                <div className="ob-backlinks">
                  <div className="ob-backlinks-title">
                    <Link2 size={13} /> Vinculado de {backlinks.length}{' '}
                    {backlinks.length === 1 ? 'nota' : 'notas'}
                  </div>
                  {backlinks.map((b) => (
                    <button
                      key={b.id}
                      className="ob-backlink-item"
                      onClick={() => abrirEmAba(b.id)}
                    >
                      {b.title}
                    </button>
                  ))}
                </div>
              )}

              {/* folga de rolagem: só a altura do que a barra/teclado tapam, medida
                  a cada frame. Fica DEPOIS dos backlinks para que eles encerrem a
                  nota, como no Obsidian — e não no meio do texto. */}
              {mode === 'edit' && folgaFinal > 0 && (
                <div className="ob-scroll-runway" style={{ height: folgaFinal }} />
              )}
            </div>
          )
        )}

        {/* quadradinho com o número de abas abertas (rodapé, estilo Obsidian mobile).
            Fica escondido enquanto o teclado está aberto, para não disputar espaço
            com a barra de formatação. */}
        {mainView === 'notes' && abas.length > 0 && !editorFocado && (
          <button
            className="ob-contador-abas"
            onClick={() => setSeletorAbas(true)}
            aria-label={`${abas.length} ${abas.length === 1 ? 'aba aberta' : 'abas abertas'}`}
            title="Abas abertas"
          >
            {abas.length}
          </button>
        )}

        {/* grade com todas as abas abertas, ocupando a tela inteira (estilo Obsidian) */}
        {seletorAbas && (
          <div className="ob-grade">
            <div className="ob-grade-lista">
              {abas.map((id) => {
                const n = notes[id];
                if (!n) return null;
                return (
                  <div key={id} className="ob-grade-item">
                    <div
                      className={
                        id === activeId
                          ? 'ob-cartao ob-cartao-ativo'
                          : 'ob-cartao'
                      }
                      onClick={() => {
                        navegarParaNota(id);
                        setSeletorAbas(false);
                      }}
                    >
                      {/* miniatura: a nota renderizada de verdade, reduzida em escala.
                          pointer-events:none no conteúdo faz o toque chegar no cartão. */}
                      <div className="ob-cartao-janela">
                        <div className="ob-cartao-escala">
                          {renderMarkdown(n.content, notesByTitle, () => {})}
                        </div>
                      </div>
                      <button
                        className="ob-cartao-x"
                        aria-label={`Fechar ${n.title || 'aba'}`}
                        onClick={(e) => {
                          e.stopPropagation(); // fechar não deve abrir a aba
                          fecharAba(id);
                        }}
                      >
                        <X size={16} strokeWidth={2.4} />
                      </button>
                    </div>
                    <div className="ob-grade-rotulo">{n.title || 'Sem título'}</div>
                  </div>
                );
              })}
            </div>

            <div className="ob-grade-rodape">
              <button
                className="ob-grade-mais"
                aria-label="Nova nota"
                onClick={() => {
                  createNote();
                  setSeletorAbas(false);
                }}
              >
                <Plus size={24} strokeWidth={2.2} />
              </button>
              <button
                className="ob-grade-limpar ob-grade-destaque"
                onClick={fecharOutrasAbas}
                disabled={abas.length <= 1}
                title="Fecha todas as abas menos a primeira (as notas continuam salvas)"
              >
                Fechar abas
              </button>
              <span className="ob-grade-contagem">
                {abas.length} {abas.length === 1 ? 'aba' : 'abas'}
              </span>
            </div>
          </div>
        )}

        {/* Barra de ferramentas: filha direta do .ob-main (que NÃO rola), com
            position:absolute — assim ela fica cravada acima do teclado e não
            acompanha a rolagem do texto (dentro de iframe no iOS, position:fixed
            é tratado como absolute e rolaria junto; por isso a âncora é o .ob-main).
            Ela aparece sempre que há uma nota em edição — ou seja, sempre que o
            cursor pode estar no texto. */}
        {mainView === 'notes' && activeNote && mode === 'edit' && (
          <div
            ref={barRef}
            className="ob-toolbar"
            style={barY !== null ? { transform: `translateY(${barY}px)` } : undefined}
            onTouchStart={() => {
              // touchstart chega ANTES de o iOS processar o toque: a seleção aqui
              // ainda é a verdadeira. É o snapshot mais confiável possível.
              const el = textareaRef.current;
              const sel = window.getSelection();
              const viva =
                el && sel && sel.rangeCount > 0 &&
                el.contains(sel.getRangeAt(0).startContainer);
              const offs = viva ? obterOffsets(el) : ultimaSelRef.current.slice();
              snapToqueRef.current = { sel: offs, t: Date.now() };
            }}
            onPointerDown={(e) => {
              e.preventDefault(); // mantém o foco (e o teclado) no editor
              selCongeladaRef.current = true; // caret fantasma pós-toque não será aceito
            }}
          >
            {/* menu de níveis de título: abre acima da barra ao tocar no H */}
            {menuTitulo && (
              <div className="ob-tb-menu">
                {[
                  { n: 1, rotulo: 'Grande' },
                  { n: 2, rotulo: 'Médio' },
                  { n: 3, rotulo: 'Pequeno' },
                  { n: 0, rotulo: 'Texto normal' },
                ].map(({ n, rotulo }) => (
                  <button
                    key={n}
                    className={
                      n === nivelTituloAtual
                        ? 'ob-tb-menu-item ob-tb-menu-item-ativo'
                        : 'ob-tb-menu-item'
                    }
                    onClick={() => {
                      definirTitulo(n);
                      setMenuTitulo(false);
                    }}
                  >
                    <span className={n > 0 ? `ob-tb-menu-amostra ob-tb-menu-h${n}` : 'ob-tb-menu-amostra'}>
                      Aa
                    </span>
                    <span className="ob-tb-menu-rotulo">{rotulo}</span>
                  </button>
                ))}
              </div>
            )}

            {/* pílula principal com os comandos (design do Obsidian mobile) */}
            <div className="ob-tb-pill">
              <button className="ob-tb-btn" onClick={desfazer} title="Desfazer"><Undo2 size={22} strokeWidth={2} /></button>
              <button className="ob-tb-btn" onClick={refazer} title="Refazer"><Redo2 size={22} strokeWidth={2} /></button>
              <button className="ob-tb-btn" onClick={() => envolver('[[', ']]', 'nota')} title="Link para nota"><Brackets size={22} strokeWidth={2} /></button>
              <button className="ob-tb-btn" onClick={() => envolver('![[', ']]', 'arquivo')} title="Embed"><File size={22} strokeWidth={2} /></button>
              <button className="ob-tb-btn" onClick={() => envolver('#', '', 'tag')} title="Tag"><Tag size={22} strokeWidth={2} /></button>
              <button className="ob-tb-btn" onClick={() => envolver('`', '`', 'código')} title="Código"><Paperclip size={22} strokeWidth={2} /></button>
              <button
                className={menuTitulo || nivelTituloAtual > 0 ? 'ob-tb-btn ob-tb-btn-ativo' : 'ob-tb-btn'}
                onClick={() => setMenuTitulo((v) => !v)}
                title="Título"
              >
                <Heading size={22} strokeWidth={2} />
              </button>
              <button className="ob-tb-btn" onClick={() => envolver('**', '**', 'negrito')} title="Negrito"><Bold size={22} strokeWidth={2} /></button>
              <button className="ob-tb-btn" onClick={() => envolver('*', '*', 'itálico')} title="Itálico"><Italic size={22} strokeWidth={2} /></button>
              <input
                type="file"
                accept="image/*"
                ref={imagemInputRef}
                style={{ display: 'none' }}
                onChange={anexarImagem}
              />
              <input
                type="file"
                accept="video/*"
                ref={videoInputRef}
                style={{ display: 'none' }}
                onChange={anexarVideo}
              />
              <button
                className="ob-tb-btn"
                onClick={() => imagemInputRef.current && imagemInputRef.current.click()}
                title="Anexar imagem"
                disabled={enviandoMidia}
              >
                <ImageIcon size={22} strokeWidth={2} />
              </button>
              <button
                className="ob-tb-btn"
                onClick={() => videoInputRef.current && videoInputRef.current.click()}
                title="Anexar vídeo"
                disabled={enviandoMidia}
              >
                <VideoIcon size={22} strokeWidth={2} />
              </button>
            </div>
            {/* botão redondo separado: recolhe o teclado */}
            <button
              className="ob-tb-kb"
              title="Fechar teclado"
              onClick={() => textareaRef.current && textareaRef.current.blur()}
            >
              <Keyboard size={22} strokeWidth={2} />
            </button>
          </div>
        )}
      </div>

      {toast && <div className="ob-toast">{toast}</div>}
    </div>
  );
}

const CSS = `
* { box-sizing: border-box; }
.ob-root {
  display: flex;
  height: 100vh;
  width: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #ffffff;
  color: #26262b;
  overflow: hidden;
}
.ob-loading { align-items: center; justify-content: center; }
.ob-spinner {
  width: 24px; height: 24px; border-radius: 50%;
  border: 3px solid #e4e4e8; border-top-color: #7c6af2;
  animation: ob-spin 0.8s linear infinite;
}
@keyframes ob-spin { to { transform: rotate(360deg); } }

.ob-sidebar {
  width: 260px;
  min-width: 260px;
  background: #f7f7f9;
  border-right: 1px solid #e4e4e8;
  display: flex;
  flex-direction: column;
  transition: margin-left 0.2s ease;
}
.ob-sidebar-collapsed { margin-left: -260px; }

/* alça na borda esquerda para abrir o painel com um toque */
.ob-edge-zone {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 18px;
  z-index: 45;
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
}
.ob-edge-grip {
  width: 4px;
  height: 46px;
  border-radius: 4px;
  background: #cfc9ef;
  margin-left: 4px;
}
.ob-edge-zone:hover .ob-edge-grip { background: #7c6af2; }

/* fundo escurecido: só entra em cena em telas estreitas */
.ob-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 49;
  background: rgba(0, 0, 0, 0.28);
}

/* telas estreitas: o painel vira uma gaveta sobreposta ao conteúdo (como no Obsidian
   mobile), em vez de espremer o editor */
@media (max-width: 700px) {
  .ob-sidebar,
  .ob-sidebar-collapsed {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 50;
    margin-left: 0;
    transition: transform 0.22s ease;
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.14);
  }
  .ob-sidebar { transform: translateX(0); }
  .ob-sidebar-collapsed { transform: translateX(-100%); box-shadow: none; }
  .ob-backdrop { display: block; }
}

.ob-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 12px;
  border-bottom: 1px solid #e4e4e8;
}
.ob-brand { font-weight: 600; font-size: 14px; color: #17171a; }

.ob-icon-btn {
  background: transparent;
  border: none;
  color: #74747c;
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ob-icon-btn:hover { background: #ececf0; color: #17171a; }
.ob-icon-btn:disabled { opacity: 0.35; cursor: default; }
.ob-icon-btn:disabled:hover { background: transparent; color: #74747c; }

.ob-search {
  margin: 10px 12px;
  display: flex;
  align-items: center;
  background: #ececf0;
  border-radius: 6px;
  padding: 6px 8px;
  gap: 6px;
}
.ob-search input {
  background: transparent;
  border: none;
  outline: none;
  color: #26262b;
  font-size: 16px;
  width: 100%;
}
.ob-search-icon { color: #9a9aa2; flex-shrink: 0; }

.ob-note-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}
.ob-empty {
  color: #9a9aa2;
  font-size: 12.5px;
  padding: 20px 12px;
  text-align: center;
}
.ob-note-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #4a4a52;
  position: relative;
}
.ob-note-item:hover { background: #ececf0; }
.ob-note-item-active { background: #ece8fd; color: #17171a; }
.ob-note-item-icon { flex-shrink: 0; color: #9a9aa2; }
.ob-note-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.ob-note-item-delete {
  opacity: 0;
  background: transparent;
  border: none;
  color: #9a9aa2;
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
}
.ob-note-item:hover .ob-note-item-delete { opacity: 1; }
.ob-note-item-delete:hover { color: #d0433a; background: #fbe4e2; }

.ob-sidebar-footer {
  border-top: 1px solid #e4e4e8;
  padding: 8px;
  display: flex;
  gap: 6px;
}
.ob-footer-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: #ececf0;
  border: none;
  color: #4a4a52;
  font-size: 11.5px;
  padding: 7px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.ob-footer-btn:hover { background: #e0e0e6; color: #17171a; }

.ob-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative; /* âncora da barra de ferramentas (absolute) */
}
.ob-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid #e4e4e8;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.ob-topbar::-webkit-scrollbar { display: none; }
.ob-topbar > * { flex-shrink: 0; }

/* quadradinho com o número de abas abertas, no rodapé */
.ob-contador-abas {
  position: absolute;
  right: 14px;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  z-index: 38;
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border: 1.6px solid #4a4a52;
  border-radius: 9px;
  background: #ffffff;
  color: #17171a;
  font-size: 13.5px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14);
}
.ob-contador-abas:active { background: #f0f0f3; }

/* grade de abas em tela cheia (estilo Obsidian mobile) */
.ob-grade {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: #f2f2f5;
}
.ob-grade-lista {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 14px;
  padding: 16px 14px 8px;
  align-content: start;
}
.ob-grade-item { min-width: 0; }
/* o cartão é a miniatura da nota */
.ob-cartao {
  position: relative;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  cursor: pointer;
}
.ob-cartao-ativo { box-shadow: 0 0 0 2.5px #7c6af2, 0 2px 10px rgba(0, 0, 0, 0.12); }
.ob-cartao-janela {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
/* renderiza a nota em largura de celular e reduz: vira uma miniatura fiel */
.ob-cartao-escala {
  /* a miniatura renderiza numa largura equivalente à de um celular (≈2,2× a do
     cartão) e é reduzida na mesma proporção — assim o texto fica no tamanho certo */
  width: 220%;
  padding: 16px 14px;
  transform: scale(0.4545);
  transform-origin: top left;
  pointer-events: none; /* o toque pertence ao cartão, não aos links da prévia */
}
.ob-cartao-x {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: rgba(236, 236, 240, 0.94);
  color: #26262b;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}
.ob-cartao-x:active { background: #dcdce2; }
.ob-grade-rotulo {
  margin-top: 8px;
  text-align: center;
  font-size: 13.5px;
  color: #26262b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ob-grade-rodape {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px calc(12px + env(safe-area-inset-bottom, 0px));
  background: #f2f2f5;
  border-top: 1px solid #e4e4e8;
  flex-wrap: wrap;
}
.ob-grade-mais {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #17171a;
  cursor: pointer;
}
.ob-grade-mais:active { background: #e4e4e8; }
.ob-grade-limpar {
  border: none;
  background: transparent;
  color: #4a4a52;
  font-size: 13.5px;
  font-family: inherit;
  padding: 8px 2px;
  cursor: pointer;
  white-space: nowrap;
}
.ob-grade-limpar:active { opacity: 0.6; }
.ob-grade-limpar:disabled { opacity: 0.32; cursor: default; }
/* destaque: chama mais atenção que um link discreto de rodapé */
.ob-grade-destaque { color: #4b3ac2; font-weight: 700; }
.ob-grade-destaque:disabled { color: #4a4a52; }
.ob-grade-contagem {
  font-size: 15px;
  font-weight: 600;
  color: #17171a;
  margin-left: auto;
}

/* faixa de abas de notas (estilo Obsidian mobile) */
.ob-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid #e4e4e8;
  background: #fafafb;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  flex-shrink: 0;
}
.ob-tabs::-webkit-scrollbar { display: none; }
.ob-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  max-width: 170px;
  padding: 6px 6px 6px 10px;
  border-radius: 8px;
  background: #ececf0;
  color: #4a4a52;
  font-size: 12.5px;
  cursor: pointer;
}
.ob-tab:hover { background: #e2e2e8; }
.ob-tab-ativa {
  background: #ece8fd;
  color: #4b3ac2;
  font-weight: 600;
  box-shadow: inset 0 0 0 1px #d6ccfa;
}
.ob-tab-icone { flex-shrink: 0; opacity: 0.7; }
.ob-tab-titulo {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ob-tab-fechar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
}
.ob-tab-fechar:hover { opacity: 1; background: rgba(0, 0, 0, 0.09); }
.ob-tab-nova {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #74747c;
  cursor: pointer;
}
.ob-tab-nova:hover { background: #ececf0; color: #17171a; }

/* Estas duas regras precisam vir DEPOIS das definições acima: media query não
   aumenta especificidade, então quem é declarado por último vence. */
@media (max-width: 700px) {
  /* no celular o quadradinho de abas substitui a faixa, poupando altura de tela */
  .ob-tabs { display: none; }
}
@media (min-width: 701px) {
  /* em telas largas a faixa já mostra tudo: o contador seria redundante */
  .ob-contador-abas { display: none; }
}

.ob-view-tabs {
  display: flex;
  background: #f7f7f9;
  border: 1px solid #e4e4e8;
  border-radius: 7px;
  padding: 2px;
  gap: 2px;
}
.ob-view-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: #74747c;
  font-size: 12.5px;
  padding: 6px 11px;
  border-radius: 5px;
  cursor: pointer;
}
.ob-view-tab:hover { color: #17171a; }
.ob-view-tab-active { background: #e4e0fb; color: #4b3ac2; }

.ob-mode-toggle-spacer { margin-left: auto; }
.ob-mode-single {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  background: #7c6af2;
  color: #fff;
  border: none;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.ob-mode-single:hover { background: #6a58e0; }
.ob-save-status {
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  white-space: nowrap;
}
.ob-save-saving { color: #74747c; background: #f0f0f3; }
.ob-save-saved { color: #1d7a3e; background: #e2f5e9; }
.ob-save-error { color: #c0362c; background: #fbe4e2; font-weight: 600; }

.ob-no-note {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #9a9aa2;
}
.ob-primary-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #7c6af2;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.ob-primary-btn:hover { background: #6a58e0; }

.ob-editor-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 20px 40px;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}
.ob-title-input {
  flex-shrink: 0;
  background: transparent;
  border: none;
  outline: none;
  font-size: 26px;
  font-weight: 700;
  color: #17171a;
  margin-bottom: 14px;
  font-family: inherit;
}
.ob-toolbar {
  position: absolute; /* relativo ao .ob-main, que não rola — imune ao scroll do texto */
  left: 0;
  right: 0;
  top: 0; /* posição real vem do translateY calculado a cada frame */
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: transparent; /* o visual fica por conta da pílula e do botão redondo */
  will-change: transform;
  pointer-events: none; /* o contêiner é só posicionamento; quem recebe toque são os filhos */
}
/* pílula branca arredondada com os comandos (igual à barra do Obsidian mobile) */
.ob-tb-pill {
  pointer-events: auto;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  background: #ffffff;
  border-radius: 999px;
  padding: 7px 14px;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.14), 0 0 0 0.5px rgba(0, 0, 0, 0.05);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.ob-tb-pill::-webkit-scrollbar { display: none; }
/* botão circular separado que recolhe o teclado */
.ob-tb-kb {
  pointer-events: auto;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #ffffff;
  border: none;
  color: #17171a;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.14), 0 0 0 0.5px rgba(0, 0, 0, 0.05);
}
.ob-tb-kb:active { background: #f0f0f3; }
.ob-tb-btn {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: #17171a;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ob-tb-btn:active { background: #f0f0f3; }
.ob-tb-btn:hover { background: #f5f5f7; }
.ob-tb-btn-ativo { background: #ece8fd; color: #4b3ac2; }

/* menu de níveis de título: cartão flutuante acima da barra */
.ob-tb-menu {
  pointer-events: auto;
  position: absolute;
  bottom: calc(100% + 10px);
  left: 12px;
  min-width: 210px;
  max-height: 42vh;
  overflow-y: auto;
  background: #ffffff;
  border-radius: 16px;
  padding: 6px;
  box-shadow: 0 6px 26px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.05);
}
.ob-tb-menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 10px;
  padding: 9px 12px;
  cursor: pointer;
  text-align: left;
  color: #17171a;
  font-family: inherit;
}
.ob-tb-menu-item:active { background: #f0f0f3; }
.ob-tb-menu-item:hover { background: #f5f5f7; }
.ob-tb-menu-item-ativo { background: #ece8fd; }
.ob-tb-menu-item-ativo .ob-tb-menu-rotulo { color: #4b3ac2; font-weight: 600; }
.ob-tb-menu-amostra {
  flex-shrink: 0;
  width: 34px;
  font-weight: 700;
  color: #4a4a52;
  font-size: 13px;
}
.ob-tb-menu-h1 { font-size: 20px; font-weight: 700; }
.ob-tb-menu-h2 { font-size: 16px; font-weight: 700; }
.ob-tb-menu-h3 { font-size: 13px; font-weight: 700; }
.ob-tb-menu-rotulo { font-size: 14px; }
.ob-preview { flex: 1 0 auto; padding-bottom: 20px; }
/* Editor com formatação ao vivo */
.ob-liveeditor {
  flex: 1 0 auto; /* cresce para preencher, mas NUNCA encolhe abaixo do conteúdo */
  outline: none;
  color: #2a2a30;
  font-size: 16px;
  line-height: 1.8;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  min-height: 300px;
  padding-bottom: 12px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  hyphens: none;
  -webkit-hyphens: none;
  caret-color: #4b3ac2;
}
.lp-b { font-weight: 700; color: #17171a; }
.lp-m { display: none; }
.lp-m-show { display: inline; color: #a9a3c9; font-weight: 400; font-style: normal; }
.lp-i { font-style: italic; }
.lp-code {
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 0.9em;
  background: #f0f0f3;
  border-radius: 4px;
  color: #b25e14;
}
.lp-link { color: #6a58e0; cursor: pointer; }
.lp-embed { color: #2e8a5c; cursor: pointer; }
/* embeds de mídia: por padrão mostra a miniatura e esconde a URL crua; com o
   cursor dentro do token (.lp-revelado) inverte, para permitir editar o link */
.lp-embed-src { display: none; }
.lp-embed.lp-revelado .lp-embed-src { display: inline; }
.lp-embed-media { display: inline-block; vertical-align: middle; cursor: text; }
.lp-embed.lp-revelado .lp-embed-media { display: none; }
.lp-h { font-weight: 700; color: #17171a; }
.lp-h1 { font-size: 24px; }
.lp-h2 { font-size: 20px; }
.lp-h3 { font-size: 17px; }
.lp-h4, .lp-h5, .lp-h6 { font-size: 15.5px; }
.ob-h { color: #17171a; margin: 0.6em 0 0.3em; font-weight: 700; }
.ob-h1 { font-size: 26px; } .ob-h2 { font-size: 21px; } .ob-h3 { font-size: 18px; }
.ob-p { margin: 0.4em 0; line-height: 1.7; color: #2a2a30; font-size: 16px; }
.ob-spacer { height: 8px; }
.ob-list { margin: 0.3em 0 0.3em 1.2em; }
.ob-list li { line-height: 1.7; font-size: 16px; color: #2a2a30; }
.ob-code {
  background: #f0f0f3;
  padding: 1px 5px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.9em;
  color: #b25e14;
}
.ob-wikilink {
  background: transparent;
  border: none;
  color: #6a58e0;
  cursor: pointer;
  font-size: inherit;
  padding: 0;
  text-decoration: none;
  border-bottom: 1px solid rgba(106,88,224,0.4);
}
.ob-wikilink:hover { border-bottom-color: #6a58e0; }
.ob-wikilink-broken { color: #c9432f; border-bottom-color: rgba(201,67,47,0.4); }
.ob-embed-img, .ob-embed-video {
  display: block;
  max-width: 260px;
  width: 100%;
  height: auto;
  border-radius: 10px;
  margin: 10px 0;
  box-shadow: 0 1px 6px rgba(0,0,0,0.08);
}

.ob-backlinks {
  flex-shrink: 0;
  margin-top: 30px;
  padding-top: 16px;
  border-top: 1px solid #e4e4e8;
}
.ob-backlinks-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #74747c;
  font-size: 12.5px;
  margin-bottom: 8px;
}
.ob-backlink-item {
  display: block;
  background: #ececf0;
  border: none;
  color: #6a58e0;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  margin-bottom: 4px;
  text-align: left;
  width: 100%;
}
.ob-backlink-item:hover { background: #e0e0e6; }

/* espaço vazio ao final da área rolável, para a última linha nunca ficar presa
   atrás da barra de ferramentas / teclado. A altura vem medida do JS — só o
   necessário, nunca um bloco fixo gigante. */
.ob-scroll-runway {
  flex-shrink: 0;
  pointer-events: none;
}

.ob-toast {
  position: fixed;
  z-index: 80; /* acima da grade de abas (70) */
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: #26262b;
  color: #f4f4f6;
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 13px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.18);
}

/* Visualizations (Graph + Sankey) */
.ob-viz-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 1px 1px, #e2e2e8 1px, transparent 0) 0 0/22px 22px,
    #ffffff;
}
.ob-viz-svg { width: 100%; height: 100%; display: block; }
.ob-viz-hint {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255,255,255,0.9);
  border: 1px solid #e4e4e8;
  color: #74747c;
  font-size: 11.5px;
  padding: 6px 12px;
  border-radius: 999px;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0,0,0,0.06);
}
.ob-sankey-link {
  fill: none;
  stroke: #7c6af2;
  stroke-opacity: 0.3;
  stroke-width: 2.4px;
}
.ob-sankey-node-group { cursor: pointer; }
.ob-sankey-node { fill: #7c6af2; }
.ob-sankey-node-active { fill: #4b3ac2; }
.ob-sankey-label {
  fill: #3a3a42;
  font-size: 11.5px;
  dominant-baseline: middle;
}

@media (max-width: 700px) {
  .ob-editor-area { padding: 16px 16px; }
  .ob-title-input { font-size: 23px; margin-bottom: 10px; }
}
`;

export default function ObsidianClone() {
  return (
    <LimiteDeErro>
      <MegApp />
    </LimiteDeErro>
  );
}
