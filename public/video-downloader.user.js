// ==UserScript==
// @name        短網址影片下載器
// @namespace   https://github.com/pin-shu/trading-office
// @version     1.0.2
// @description 在短網址影片頁面（fito.cc、mork.ro、lurl.cc、myppt.cc、risu.io、iiil.io）自動抓出影片：MP4 直接列出連結，HLS 串流下載後轉成 MP4。透過 GM_xmlhttpRequest 抓取，不受頁面 CORS 限制，可抓跨網域的播放清單。
// @author      Pinshu
// @match       https://fito.cc/*
// @match       https://mork.ro/*
// @match       https://lurl.cc/*
// @match       https://myppt.cc/*
// @match       https://risu.io/*
// @match       https://iiil.io/*
// @grant       GM_xmlhttpRequest
// @connect     *
// @run-at      document-idle
// @require     https://cdn.jsdelivr.net/npm/mux.js@6/dist/mux.min.js
// ==/UserScript==
// @connect 用 * 的原因：影片串流的 CDN 網域不固定（例如 fito.cc 的串流在 gnetwork.gliastudios.com、gnetwork.b-cdn.net），無法逐一列出。
// 安裝方式：把這個檔案拖進 Tampermonkey 擴充功能頁面，或在 Tampermonkey 選「新增腳本」後貼上。
// 原理：GM_xmlhttpRequest 走擴充功能通道，不受頁面 CORS 限制，可直接抓跨網域的播放清單與分段；
// 轉封裝用 @require 載入的 mux.js（jsdelivr CDN）。
(function () {
  'use strict';

  // 若已載入過，直接重新執行主流程（例如使用者在同一頁再點一次）
  if (typeof window !== 'undefined' && window.__videoDownloader && window.__videoDownloader.run) {
    window.__videoDownloader.run();
    return;
  }

  var MUXJS_URL = 'https://cdn.jsdelivr.net/npm/mux.js@6/dist/mux.min.js';
  var MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv)(\?|#|$)/i;
  var HLS_EXT = /\.m3u8(\?|#|$)/i;

  var panel = null;
  var statusEl = null;
  var listEl = null;
  var busy = false;

  /* ---------- 浮動面板 ---------- */

  function createPanel() {
    if (panel && panel.parentNode) {
      statusEl.textContent = '';
      listEl.innerHTML = '';
      return;
    }
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:999999;background:#fff;color:#111;padding:14px;border-radius:12px;font:14px/1.6 system-ui,-apple-system,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.4);max-height:70vh;overflow:auto;';
    var title = document.createElement('div');
    title.textContent = '影片下載小工具';
    title.style.cssText = 'font-weight:700;margin-bottom:6px;';
    statusEl = document.createElement('div');
    listEl = document.createElement('div');
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ 關閉';
    closeBtn.style.cssText = 'margin-top:10px;padding:6px 14px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;cursor:pointer;';
    closeBtn.onclick = function () {
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
    };
    var rescanBtn = document.createElement('button');
    rescanBtn.textContent = '⟳ 重新掃描';
    rescanBtn.style.cssText = 'margin-top:10px;margin-left:8px;padding:6px 14px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;cursor:pointer;';
    rescanBtn.onclick = function () { main(); };
    panel.appendChild(title);
    panel.appendChild(statusEl);
    panel.appendChild(listEl);
    panel.appendChild(closeBtn);
    panel.appendChild(rescanBtn);
    document.body.appendChild(panel);
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#c00' : '#111';
  }

  function addLink(url, label) {
    if (!listEl) return;
    var row = document.createElement('div');
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label + '：' + url.slice(0, 60) + (url.length > 60 ? '…' : '');
    a.style.cssText = 'word-break:break-all;color:#06c;';
    row.appendChild(a);
    listEl.appendChild(row);
  }

  /* ---------- 影片網址偵測 ---------- */

  function addUrl(found, url) {
    if (!url || typeof url !== 'string') return;
    if (HLS_EXT.test(url)) found[url] = 'm3u8';
    else if (MEDIA_EXT.test(url)) found[url] = 'mp4';
  }

  function collectUrls() {
    var found = {};
    try {
      var els = document.querySelectorAll('video, source');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        addUrl(found, el.currentSrc || el.src || el.getAttribute('src'));
      }
    } catch (e) { /* 忽略 */ }
    try {
      var entries = performance.getEntriesByType('resource');
      for (var j = 0; j < entries.length; j++) {
        addUrl(found, entries[j].name);
      }
    } catch (e2) { /* 忽略 */ }
    return found;
  }

  /* ---------- HLS 清單解析（純邏輯） ---------- */

  function resolveUrl(base, rel) {
    try {
      return new URL(rel, base).href;
    } catch (e) {
      return rel;
    }
  }

  function isMaster(text) {
    return text.indexOf('#EXT-X-STREAM-INF') !== -1;
  }

  // 主清單 → [{ bandwidth, uri }]（uri 已解析為絕對網址）
  function parseMaster(text, baseUrl) {
    var lines = text.split(/\r?\n/);
    var variants = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
        var bw = 0;
        var m = line.match(/BANDWIDTH=(\d+)/);
        if (m) bw = parseInt(m[1], 10);
        var uri = (lines[i + 1] || '').trim();
        if (uri && uri.charAt(0) !== '#') {
          variants.push({ bandwidth: bw, uri: resolveUrl(baseUrl, uri) });
        }
      }
    }
    return variants;
  }

  // 媒體清單 → { segments, key, initSegment }
  // segments 只收 #EXTINF 後面的 URI 行；key 為加密標籤（METHOD 非 NONE 時）
  function parseMedia(text, baseUrl) {
    var lines = text.split(/\r?\n/);
    var segments = [];
    var key = null;
    var initSegment = null;
    var expectSegment = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '#') {
        if (line.indexOf('#EXT-X-KEY') === 0) {
          var km = line.match(/METHOD=([^,]+)/);
          if (km && km[1].toUpperCase() !== 'NONE') key = line;
        } else if (line.indexOf('#EXT-X-MAP') === 0) {
          var um = line.match(/URI="([^"]+)"/);
          if (um) initSegment = resolveUrl(baseUrl, um[1]);
        } else if (line.indexOf('#EXTINF') === 0) {
          expectSegment = true;
        }
        continue;
      }
      if (expectSegment) {
        segments.push(resolveUrl(baseUrl, line));
        expectSegment = false;
      }
    }
    return { segments: segments, key: key, initSegment: initSegment };
  }

  /* ---------- 網路存取（GM_xmlhttpRequest，不受頁面 CORS 限制） ---------- */

  // GM_xmlhttpRequest 走擴充功能通道，不受頁面 CORS 限制，可直接抓跨網域
  // 的播放清單與分段；沒有 GM 時（例如貼進主控台執行）退回一般 fetch。
  function gmRequest(url, responseType) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        reject(new Error('GM_xmlhttpRequest 不可用'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: responseType,
        onload: function (resp) {
          if (resp.status >= 200 && resp.status < 300) {
            resolve(responseType === 'arraybuffer' ? resp.response : resp.responseText);
          } else {
            reject(new Error('HTTP ' + resp.status));
          }
        },
        onerror: function () {
          reject(new Error('Load failed'));
        }
      });
    });
  }

  function fetchText(url) {
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      return gmRequest(url, 'text');
    }
    return fetch(url, { credentials: 'include' }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    });
  }

  function fetchArrayBuffer(url) {
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      return gmRequest(url, 'arraybuffer');
    }
    return fetch(url, { credentials: 'include' }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.arrayBuffer();
    });
  }

  // 3 並行下載分段，單段失敗重試一次；onProgress(done, total)
  function downloadSegments(urls, onProgress) {
    var results = new Array(urls.length);
    var done = 0;
    var index = 0;
    return new Promise(function (resolve, reject) {
      var settled = false;
      function next() {
        if (settled) return;
        if (index >= urls.length) return;
        var cur = index++;
        var attempts = 0;
        function attempt() {
          fetchArrayBuffer(urls[cur]).then(function (buf) {
            if (settled) return;
            results[cur] = buf;
            done++;
            if (onProgress) onProgress(done, urls.length);
            if (done >= urls.length) {
              settled = true;
              resolve(results);
            } else {
              next();
            }
          }).catch(function (err) {
            if (settled) return;
            attempts++;
            if (attempts < 2) {
              attempt();
            } else {
              settled = true;
              reject(new Error('第 ' + (cur + 1) + ' 段下載失敗（' + err.message + '）'));
            }
          });
        }
        attempt();
      }
      var workers = Math.min(3, urls.length);
      for (var w = 0; w < workers; w++) next();
    });
  }

  /* ---------- mux.js 轉封裝 ---------- */

  function loadMuxJs() {
    return new Promise(function (resolve, reject) {
      // @require 已把 mux.js 載入油猴沙箱：先找沙箱全域 muxjs
      if (typeof muxjs !== 'undefined' && muxjs && muxjs.mp4 && muxjs.mp4.Transmuxer) {
        resolve(muxjs);
        return;
      }
      if (typeof window !== 'undefined' && window.muxjs && window.muxjs.mp4 && window.muxjs.mp4.Transmuxer) {
        resolve(window.muxjs);
        return;
      }
      var s = document.createElement('script');
      s.src = MUXJS_URL;
      s.onload = function () {
        if (window.muxjs && window.muxjs.mp4) resolve(window.muxjs);
        else reject(new Error('mux.js 載入後找不到 Transmuxer'));
      };
      s.onerror = function () {
        reject(new Error('mux.js 載入失敗（可能是頁面擋外部腳本）'));
      };
      document.head.appendChild(s);
    });
  }

  function transmuxToMp4(buffers, muxjs) {
    return new Promise(function (resolve, reject) {
      try {
        var transmuxer = new muxjs.mp4.Transmuxer();
        var chunks = [];
        transmuxer.on('data', function (segment) {
          if (segment.initSegment) chunks.push(segment.initSegment);
          if (segment.data) chunks.push(segment.data);
        });
        transmuxer.on('done', function () {
          transmuxer.dispose();
          resolve(new Blob(chunks, { type: 'video/mp4' }));
        });
        transmuxer.on('error', function () {
          reject(new Error('轉封裝失敗'));
        });
        buffers.forEach(function (buf) {
          transmuxer.push(new Uint8Array(buf));
        });
        transmuxer.flush();
      } catch (e) {
        reject(new Error('轉封裝失敗：' + e.message));
      }
    });
  }

  /* ---------- 下載觸發與檔名 ---------- */

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 5000);
  }

  function fileNameFromUrl(url, ext) {
    try {
      var path = new URL(url).pathname;
      var base = path.substring(path.lastIndexOf('/') + 1);
      base = decodeURIComponent(base || '');
      if (base) return base.replace(/\.[^.]+$/, '') + ext;
    } catch (e) { /* 忽略 */ }
    return 'video' + ext;
  }

  function describeError(err) {
    var m = (err && err.message) || String(err);
    if (/Failed to fetch|NetworkError|Network request failed|Load failed/i.test(m)) {
      return '讀不到播放清單（對方擋跨網域讀取或網路問題）。可長按上方「串流連結」複製網址，貼到下載 App 或電腦下載。';
    }
    return m;
  }

  /* ---------- HLS 下載主流程 ---------- */

  function downloadHls(manifestUrl) {
    if (busy) {
      setStatus('正在下載中，請稍候…');
      return Promise.resolve();
    }
    busy = true;
    setStatus('正在讀取播放清單…');
    var finish = function () { busy = false; };
    return fetchText(manifestUrl).then(function (text) {
      if (text.indexOf('#EXTM3U') === -1) {
        throw new Error('連結不是播放清單（可能已失效，請回影片頁面重新抓取連結）');
      }
      if (isMaster(text)) {
        var variants = parseMaster(text, manifestUrl);
        if (!variants.length) throw new Error('主清單沒有可用畫質');
        variants.sort(function (a, b) { return b.bandwidth - a.bandwidth; });
        setStatus('已選最高畫質，正在讀取媒體清單…');
        return fetchText(variants[0].uri).then(function (t2) {
          return { text: t2, url: variants[0].uri };
        });
      }
      return { text: text, url: manifestUrl };
    }).then(function (res) {
      var parsed = parseMedia(res.text, res.url);
      if (parsed.key) throw new Error('此串流有加密，無法下載');
      if (!parsed.segments.length) throw new Error('清單中沒有分段');
      var urls = parsed.initSegment
        ? [parsed.initSegment].concat(parsed.segments)
        : parsed.segments;
      setStatus('已下載 0 / ' + urls.length + ' 段…');
      return downloadSegments(urls, function (done, total) {
        setStatus('已下載 ' + done + ' / ' + total + ' 段…');
      }).then(function (bufs) {
        return { bufs: bufs, url: manifestUrl };
      });
    }).then(function (res) {
      setStatus('分段下載完成，正在轉成 MP4…');
      return loadMuxJs().then(function (muxjs) {
        return transmuxToMp4(res.bufs, muxjs);
      }).then(function (mp4Blob) {
        triggerDownload(mp4Blob, fileNameFromUrl(res.url, '.mp4'));
        setStatus('完成，已開始下載 MP4。');
      }).catch(function (err) {
        var tsBlob = new Blob(res.bufs, { type: 'video/mp2t' });
        triggerDownload(tsBlob, fileNameFromUrl(res.url, '.ts'));
        setStatus('轉 MP4 失敗（' + err.message + '），已改下載 .ts 檔，請用 VLC 播放。');
      });
    }).catch(function (err) {
      var msg = describeError(err);
      if (/讀不到播放清單/.test(msg)) {
        var host = '';
        try { host = new URL(manifestUrl).host; } catch (e) {}
        if (host) msg += ' 清單在 ' + host + '（若與影片頁面不同網域，就是對方擋跨網域讀取）。';
      }
      setStatus('下載失敗：' + msg, true);
    }).then(finish, finish);
  }

  /* ---------- 主流程 ---------- */

  function main() {
    createPanel();
    if (busy) {
      setStatus('正在下載中，請稍候…');
      return;
    }
    var found = collectUrls();
    var mp4s = [];
    var m3u8s = [];
    Object.keys(found).forEach(function (u) {
      if (found[u] === 'mp4') mp4s.push(u);
      else m3u8s.push(u);
    });
    if (!mp4s.length && !m3u8s.length) {
      setStatus('沒找到影片檔案，請先按播放，等影片開始播再執行一次。', true);
      return;
    }
    if (mp4s.length) {
      setStatus('找到 ' + mp4s.length + ' 個影片檔案（點連結開新分頁）：');
      mp4s.forEach(function (u, i) {
        addLink(u, '影片 ' + (i + 1));
      });
    }
    if (m3u8s.length) {
      m3u8s.forEach(function (u, i) {
        addLink(u, '串流連結 ' + (i + 1) + '（長按可複製）');
      });
      downloadHls(m3u8s[0]);
    }
  }

  // 測試／除錯用 hook（不影響正常執行）
  window.__videoDownloader = {
    version: '1.0.2',
    run: main,
    parseMaster: parseMaster,
    parseMedia: parseMedia,
    isMaster: isMaster,
    resolveUrl: resolveUrl,
    fetchText: fetchText,
    fetchArrayBuffer: fetchArrayBuffer,
    downloadSegments: downloadSegments,
    downloadHls: downloadHls,
    transmuxToMp4: transmuxToMp4,
    loadMuxJs: loadMuxJs
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
