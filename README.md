# trading-office

交易團隊的 3D 辦公大樓。即時顯示各 agent 的狀態（僅紙上交易，paper trading）。

畫面是一棟等距辦公室：誰在工作、待命、走向誰，或正在交接，都會透過 Server-Sent Events 推到瀏覽器。

## 本地執行

需要 [Bun](https://bun.sh)。

```bash
bun server.ts
```

預設聽 `http://localhost:3000`。`package.json` 的 start 腳本相同：`bun run start`。

## 環境變數

| 變數 | 說明 |
| --- | --- |
| `OFFICE_TOKEN` | `POST /api/event` 的 Bearer token。未設定時所有寫入都會被拒絕（401）。不要把 token 寫進程式碼。 |
| `PORT` | 監聽埠，預設 `3000`。 |

```bash
OFFICE_TOKEN=your-token PORT=3000 bun server.ts
```

寫入一筆狀態：

```bash
curl -X POST http://localhost:3000/api/event \
  -H "Authorization: Bearer $OFFICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"crypto","action":"working","status":"掃描市場"}'
```

其他路由維持不變：`GET /health`、`GET /api/state`、`GET /events/stream`（SSE）。

## 部署

推送到 `main` 會在 Railway 自動部署。`railway.json` 使用 Railpack（Bun）建置，啟動指令是 `bun server.ts`，健康檢查路徑是 `/health`。

在 Railway 服務變數設定 `OFFICE_TOKEN`。需要改埠時再設定 `PORT`。

## 修改畫面

視覺與前端互動都在 `public/index.html`。伺服器啟動時讀取這個檔案，並在 `/` 與 `/index.html` 提供。改完畫面後重新執行 `bun server.ts` 即可。
