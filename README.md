# MyTestflight CLI — `my-testflight-cli`

CLI chính thức cho **MyTestflightServer**: đăng nhập một lần, sau đó tạo ứng dụng, đẩy APK theo
từng kiến trúc (ABI) hoặc bản universal, xem catalog/phiên bản và tải APK — tất cả từ terminal
hoặc CI, không cần mở dashboard.

```text
Android build (Gradle) ──► testflight release ──► MyTestflightServer ──► /data volume
                                                        │
                                          ┌─────────────┴─────────────┐
                                          ▼                           ▼
                              MyAndroidTestflight             MyTestflightDashboard
                              (catalog + cài APK)             (quản trị web)
```

Lệnh `testflight` (alias `tf`) nói chuyện trực tiếp với API `/api/v1` mà server, app Android và
dashboard cùng dùng. Vì vậy mọi thứ đẩy bằng CLI xuất hiện ngay trong app Android và dashboard, và
ngược lại.

## Liên hệ giữa các dự án

| Thành phần | Vai trò | CLI dùng gì từ đó |
|---|---|---|
| [`MyTestflightServer`](../MyTestflightServer/) | Node 22 + Fastify, catalog + write API, quản lý `/data` | Toàn bộ endpoint `/api/v1`, `management_key` trong `data/config.json` |
| [`MyAndroidTestflight`](../MyAndroidTestflight/) | App Kotlin/Compose đọc catalog và cài APK | APK/version do CLI đẩy lên được app nhìn thấy và cài |
| [`MyTestflightDashboard`](../MyTestflightDashboard/) | Dashboard web (Vite, GitHub Pages) | Cùng API với CLI (khác giao diện) |
| **`TestFlightCLI`** (repo này) | Client terminal/CI cho server | — |

Quy tắc dữ liệu và API đầy đủ nằm ở [`README.md` gốc](../README.md): layout volume, `app.json`,
`version.json`, danh sách ABI, mã lỗi. CLI chỉ là lớp gọi API đó, không có định dạng riêng.

## Yêu cầu

- **Node.js 22+** (dùng `fetch`, `AbortSignal.timeout`, ESM).
- Một **MyTestflightServer** truy cập được qua http(s).
- **Management key** của server: `management_key` trong `data/config.json`
  (`node -p 'require("./data/config.json").management_key'`).

## Cài đặt

```bash
# Toàn cục
npm install -g my-testflight-cli
testflight --version
tf --version          # alias ngắn

# Không cài, chạy trực tiếp
npx my-testflight-cli --help

# Từ source trong workspace
cd TestFlightCLI
npm ci
npm run build
npm link              # hoặc: node dist/cli.js <command>
```

## Bắt đầu nhanh

```bash
# 1. Lưu server URL + management key (kiểm tra trước khi lưu)
testflight login http://127.0.0.1:8080
#    hoặc không tương tác:
testflight login --url http://127.0.0.1:8080 --key "$KEY"

# 2. Tạo ứng dụng
testflight apps create crm --name "Internal CRM" --package com.company.crm

# 3. Đẩy bản phát hành (ABI tự nhận từ APK)
testflight release crm ./app/build/outputs/apk/release/app-arm64-v8a.apk \
  --version 1.4.2 --version-code 142 --min-sdk 26 \
  --release-notes "Sửa lỗi hết hạn đăng nhập"

# 4. Kiểm tra
testflight apps
testflight versions crm
testflight versions abis crm 1.4.2

# 5. Tải lại để kiểm tra
testflight download crm 1.4.2 --out ./builds
```

`release` (alias `push`) làm đúng luồng write API của server: tạo version (bản nháp) → upload từng
APK vào `PUT .../artifacts/:abi`. Server tự tính SHA-256, đặt tên file và cập nhật
`version.json.artifacts`. Version chỉ xuất hiện trong catalog công khai sau khi có APK đầu tiên.

## Đăng nhập và cấu hình

### `testflight login`

```text
testflight login [url] [options]

  -u, --url <url>       Server base URL (có thể kèm path prefix)
  -k, --key <key>       Management key
      --key-stdin       Đọc key từ stdin (CI)
      --no-verify       Lưu mà không gọi server
  -p, --profile <name>  Tên profile (mặc định: profile hiện tại)
```

- Không có `--url`/`--key` và đang chạy trong terminal → CLI hỏi từng giá trị; key được **ẩn** khi
  nhập.
- Có `--no-verify` → lưu ngay, không kiểm tra.
- Mặc định CLI kiểm tra:

  1. `GET /api/v1/health` — server sống.
  2. Một request ghi **vô hại** `PUT /api/v1/apps/__testflight_cli_probe__` với body `{}`.
     Server xác thực key **trước** khi kiểm tra id/body, nên `400` nghĩa là key hợp lệ, `401` là
     key sai, `503` là server chưa có `management_key`. Không có dữ liệu nào được tạo.

- Base URL phải là http(s) origin, có thể kèm path prefix (ví dụ
  `https://example.com/testflight`), không chứa credentials/query/fragment.

File cấu hình mặc định:

| Nền tảng | Đường dẫn |
|---|---|
| Linux/macOS | `$XDG_CONFIG_HOME/testflight/config.json` hoặc `~/.config/testflight/config.json` |
| Windows | `%APPDATA%\testflight\config.json` |

Có thể đổi bằng `TESTFLIGHT_CONFIG=/absolute/path/config.json`.

```json
{
  "version": 1,
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "baseUrl": "http://127.0.0.1:8080",
      "managementKey": "…",
      "createdAt": "2026-11-26T08:00:00.000Z",
      "updatedAt": "2026-11-26T08:00:00.000Z"
    }
  }
}
```

File được ghi atomic với quyền `0600` (thư mục `0700`). `doctor` cảnh báo nếu quyền bị mở.

### Nhiều môi trường

```bash
testflight login --profile staging --url https://staging.example.com --key "$STAGING_KEY"
testflight login --profile prod    --url https://apps.example.com    --key "$PROD_KEY"

testflight config                 # danh sách profile, key được che
testflight config use staging     # đổi mặc định
testflight apps --profile prod    # dùng profile khác cho một lệnh
testflight logout --profile staging
testflight logout --all
```

### Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `TESTFLIGHT_BASE_URL` | Ghi đè base URL của profile |
| `TESTFLIGHT_MANAGEMENT_KEY` | Ghi đè management key |
| `TESTFLIGHT_PROFILE` | Profile mặc định cho lệnh |
| `TESTFLIGHT_CONFIG` | Đường dẫn file cấu hình |
| `NO_COLOR` | Tắt màu (chuẩn NO_COLOR) |

Thứ tự ưu tiên cho URL/key: **flag** (`--base-url`, `--key`) → **biến môi trường** → **profile**.
CLI tự đọc `.env` ở thư mục hiện tại nếu có; biến môi trường thật luôn thắng. Xem
[`.env.example`](.env.example).

Với CI, không cần `login`:

```bash
TESTFLIGHT_BASE_URL=https://apps.example.com \
TESTFLIGHT_MANAGEMENT_KEY="$TESTFLIGHT_KEY" \
testflight release crm app.apk --version 1.4.2 --version-code 142
```

## Lệnh

Mọi lệnh nhận các **global option**:

| Option | Tác dụng |
|---|---|
| `--json` | Chỉ in JSON ra stdout (phù hợp CI) |
| `-p, --profile <name>` | Dùng profile chỉ định |
| `--base-url <url>` | Ghi đè server URL |
| `--key <key>` | Ghi đè management key |
| `--verbose` | In thêm chi tiết/stack khi lỗi |
| `--no-color` | Tắt ANSI |
| `-h, --help` | Trợ giúp cho lệnh |

Chạy `testflight <command> --help` để xem chi tiết từng lệnh.

### Thiết lập

| Lệnh | Mô tả |
|---|---|
| `login` | Lưu URL + key, kiểm tra trước khi lưu |
| `logout [--all]` | Xoá profile hoặc toàn bộ cấu hình |
| `whoami` | Profile, server, key (che), nguồn cấu hình |
| `config [list\|path\|use <name>]` | Xem/đổi profile, in đường dẫn file |
| `doctor` | Kiểm tra Node, file cấu hình, quyền, server, key; exit 1 nếu lỗi |

### Ứng dụng

| Lệnh | Mô tả |
|---|---|
| `apps` / `apps list [--search <q>] [--sort name\|id\|latest]` | Liệt kê ứng dụng |
| `apps <appId>` / `apps get <appId>` | Chi tiết ứng dụng + phiên bản đã publish |
| `apps create <appId> [--name] [--package] [--description] [--developer] [--icon <file>]` | Tạo ứng dụng, upload icon tuỳ chọn |
| `apps update <appId> [--name] [--package] [--description] [--developer]` | Sửa metadata |
| `apps delete <appId> [--yes]` | Xoá ứng dụng + toàn bộ version/APK |
| `apps icon <appId> --file <png\|jpg\|webp>` / `--delete` | Đổi/xoá icon (≤ 2 MiB) |

`appId` và `versionName` theo đúng quy tắc server: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

### Phiên bản và kiến trúc

| Lệnh | Mô tả |
|---|---|
| `versions <appId>` / `versions list <appId> [--published]` | Danh sách version (mặc định gồm cả draft) |
| `versions get <appId> <versionName>` | Chi tiết version + artifacts/checksum |
| `versions abis <appId> <versionName>` | **Các kiến trúc (ABI)** trong version, artifact mặc định |
| `versions create <appId> <versionName> --version-code <n> [...]` | Tạo version nháp, chưa upload |
| `versions update <appId> <versionName> [...]` | Sửa `versionCode`, `minSdk`, release notes, `publishedAt` |
| `versions delete <appId> <versionName> [--yes]` | Xoá version + APK |
| `artifacts list <appId> <versionName>` | Liệt kê artifact |
| `artifacts delete <appId> <versionName> <abi> [--yes]` | Xoá một ABI (xoá ABI cuối → version thành draft) |

```bash
testflight versions crm
testflight versions abis crm 1.4.2
testflight versions get crm 1.4.2 --json
testflight versions update crm 1.4.2 --notes-file ./CHANGELOG-latest.md
testflight versions update crm 1.4.2 --clear-min-sdk
```

### Phát hành

```text
testflight release <appId> <apk...> --version <name> --version-code <n> [options]
alias: testflight push ...
```

| Option | Ý nghĩa |
|---|---|
| `--version <name>` | **Bắt buộc** — tên version, ví dụ `1.4.2` |
| `--version-code <n>` | **Bắt buộc** — số nguyên dương |
| `--abi <abi>` | Lặp lại được, hoặc `a,b`; một giá trị cho mỗi APK |
| `--universal` | Ép một APK duy nhất thành `universal` |
| `--min-sdk <n>` | `minSdk` |
| `--release-notes <text>` / `--notes-file <path>` | Ghi chú phát hành |
| `--published-at <iso>` | Thời điểm publish (mặc định: server tự đặt) |
| `--create` | Tạo app nếu chưa tồn tại |
| `--name`, `--package`, `--description`, `--developer` | Metadata dùng khi `--create` |
| `-f, --force` | Ghi đè artifact đã có và cập nhật metadata |
| `-y, --yes` | Chấp nhận thay thế mà không hỏi (kể cả không có TTY) |
| `-n, --dry-run` | In kế hoạch, không gửi thay đổi |
| `--no-progress` | Ẩn thanh tiến trình upload |

Ví dụ:

```bash
# Một APK, ABI tự nhận diện
testflight release crm app-arm64-v8a.apk --version 1.4.2 --version-code 142

# Split APK theo kiến trúc
testflight release crm app-arm64-v8a.apk app-x86_64.apk \
  --version 1.4.2 --version-code 142 --abi arm64-v8a --abi x86_64

# APK fat → universal
testflight release crm app-universal.apk --version 1.4.2 --version-code 142

# App chưa có trong catalog
testflight release new-app app.apk --version 1.0.0 --version-code 1 \
  --create --name "New App" --package com.company.newapp

# Xem trước
testflight release crm app.apk --version 1.4.3 --version-code 143 --dry-run

# Thay thế bản đã publish (cùng version)
testflight release crm app.apk --version 1.4.2 --version-code 142 --force
```

#### Cách CLI chọn ABI

Với mỗi APK, theo thứ tự:

1. `--abi` được truyền → dùng đúng giá trị đó.
2. Đọc **ZIP central directory** của APK, tìm `lib/<abi>/*.so`:
   - đúng **một** ABI → dùng ABI đó;
   - **nhiều** ABI → `universal`;
   - **không** có native lib → bước 3.
3. Tên file có token ABI (`app-arm64-v8a.apk`, `release_x86_64.apk`) → dùng token đó.
4. Không xác định được → `universal`.

ABI hợp lệ (cùng thứ tự ưu tiên với server): `universal`, `arm64-v8a`, `armeabi-v7a`, `x86_64`,
`x86`, `riscv64`, `armeabi`. Mỗi version chỉ có tối đa một APK cho mỗi ABI; trùng ABI là lỗi và CLI
dừng trước khi upload. Artifact `universal` luôn là artifact mặc định của version.

#### Quy tắc ghi đè

- Version **chưa tồn tại** → tạo mới rồi upload.
- Version **đang là draft** (chưa có APK) → thêm artifact, không cần `--force`.
- Version **đã publish** và có artifact cùng ABI, hoặc metadata khác đi → CLI hỏi (nếu là terminal)
  hoặc yêu cầu `--force`/`--yes` (nếu chạy CI). Không bao giờ âm thầm ghi đè.
- Re-run sau lỗi giữa chừng: thêm `--force` để hoàn tất; các artifact đã upload sẽ được thay thế
  bằng cùng file (idempotent).

### Tải APK

```text
testflight download <appId> <versionName> [--abi <abi>] [--out <path>] [--force]
```

- Mặc định tải artifact mặc định của version; `--abi` chọn chính xác một kiến trúc.
- `--out` là file, hoặc thư mục **đã tồn tại**; mặc định `./<appId>-<version>[-<abi>].apk`.
- Nếu server trả `X-Checksum-Sha256`, CLI tính SHA-256 khi tải và **chỉ đổi tên file khi khớp**;
  file hỏng bị xoá.
- Đọc là public, không cần management key.

## Ánh xạ lệnh → API

| Lệnh CLI | Endpoint |
|---|---|
| `login` | `GET /api/v1/health`, `PUT /api/v1/apps/__testflight_cli_probe__` (vô hại) |
| `apps list`, `apps get` | `GET /api/v1/apps`, `GET /api/v1/apps/:appId` |
| `apps create/update/delete` | `POST /api/v1/apps`, `PUT`/`DELETE /api/v1/apps/:appId` |
| `apps icon` | `PUT`/`DELETE /api/v1/apps/:appId/icon` |
| `versions list`, `versions get/abis` | `GET /api/v1/apps/:appId/versions[/:version]` (admin, gồm draft) |
| `versions create/update/delete` | `POST`, `PUT`, `DELETE /api/v1/apps/:appId/versions[/:version]` |
| `release` | `GET` kiểm tra → `POST /versions` → `PUT .../artifacts/:abi` (hoặc `PUT /versions/:v`) |
| `download` | `GET /api/v1/apps/:appId/versions/:version/download[?abi=]` |
| `artifacts delete` | `DELETE .../artifacts/:abi` |

Mã lỗi server được giữ nguyên trong thông báo, ví dụ `HTTP 409 version_exists`, `HTTP 401
invalid_management_key`, `HTTP 413 payload_too_large`. CLI thêm gợi ý xử lý tương ứng.

## JSON, exit code và CI

- `--json` chỉ in **một** object JSON ra stdout; log/tiến trình bị tắt (cảnh báo vẫn ở stderr).
- Exit code: `0` thành công, `1` lỗi server/mạng/kiểm tra, `2` sai cú pháp/flag, `130` bị huỷ
  (`Ctrl+C`).
- Lỗi luôn ở stderr, dạng `error: …` + `hint: …`.

Ví dụ đọc kết quả trong CI:

```bash
testflight release crm app.apk --version 1.4.2 --version-code 142 --json > release.json
node -p "require('./release.json').version.abis.join(',')"
```

GitHub Actions:

```yaml
- name: Publish to MyTestflight
  run: |
    npx --yes my-testflight-cli@latest release crm \
      app/build/outputs/apk/release/app-arm64-v8a.apk \
      --version "${{ github.ref_name }}" \
      --version-code "${{ github.run_number }}" \
      --release-notes "Built from ${{ github.sha }}" \
      --json
  env:
    TESTFLIGHT_BASE_URL: ${{ secrets.TESTFLIGHT_BASE_URL }}
    TESTFLIGHT_MANAGEMENT_KEY: ${{ secrets.TESTFLIGHT_MANAGEMENT_KEY }}
```

`doctor` cũng dùng được như một bước kiểm tra kết nối/key trước khi phát hành.

## Phát triển

```bash
cd TestFlightCLI
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

- **Unit test**: `test/*.test.ts` chạy bằng `node --test` + `tsx`, không cần server thật.
- **Fake server** (`test/fake-server.ts`) mô phỏng đúng shape API, auth, upload, download, checksum.
- **CLI end-to-end** (`test/cli.test.ts`) spawn `src/cli.ts` và chạy trọn luồng
  login → create → release → versions → download → force.
- **Fixture APK** (`test/zip-fixture.ts`) tạo ZIP hợp lệ tối thiểu với `lib/<abi>/`, dùng để kiểm
  tra bộ đọc central directory.

Cấu trúc:

```text
TestFlightCLI/
├── src/
│   ├── cli.ts, run.ts          # entry, dispatch, exit code
│   ├── api.ts                  # client + upload/download stream
│   ├── config.ts               # profile, 0600 config, env precedence
│   ├── args.ts, output.ts      # parseArgs, bảng/màu/JSON/tiến trình
│   ├── apk.ts, abi.ts, plan.ts # đọc ABI trong APK, kế hoạch release
│   ├── help.ts, prompt.ts
│   └── commands/               # setup, apps, versions, release, download, artifacts
├── test/                       # unit + fake server + CLI e2e
├── .github/workflows/          # ci.yml, publish.yml
└── dist/                       # build output (không commit)
```

## CI/CD của package

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml): mọi push/PR → typecheck, test, build,
  smoke test trên Node 22 và 24.
- [`.github/workflows/publish.yml`](.github/workflows/publish.yml): push tag `v*` → kiểm tra tag
  khớp `package.json` → test/build → `npm publish --provenance` → tạo GitHub Release.

Phát hành phiên bản mới:

```bash
npm version patch          # hoặc minor / major; tạo commit + tag vX.Y.Z
git push --follow-tags
```

Cần cấu hình **một lần** trên GitHub:

1. Tạo npm access token (npmjs.com → Access Tokens → Granular Access Token, quyền publish package
   `my-testflight-cli`).
2. Repo **Settings → Secrets and variables → Actions → New repository secret**:
   `NPM_TOKEN`.
3. (Tuỳ chọn) Dùng **npm trusted publishing** thay token: trên npmjs.com khai báo GitHub repo +
   workflow `publish.yml`, rồi bỏ biến `NODE_AUTH_TOKEN` khỏi bước publish. `id-token: write` đã có
   sẵn.

`--provenance` tạo attestation SLSA gắn với commit/tag trên GitHub. Nếu repo GitHub có owner hoặc
tên khác, cập nhật `repository` trong `package.json` để attestation trỏ đúng nguồn.

## Bảo mật

- Management key là **toàn quyền ghi** với server. Không commit key, không đưa vào log.
- CLI lưu key trong file `0600`; với CI, ưu tiên `TESTFLIGHT_MANAGEMENT_KEY` từ secret.
- Server lưu key dạng plaintext trong `data/config.json`; dùng mạng tin cậy hoặc TLS (reverse
  proxy/Cloudflare Tunnel) khi truy cập từ ngoài.
- CLI không gửi key cho request đọc (catalog/version/download đều public theo thiết kế server).
- CORS không ảnh hưởng CLI (không phải trình duyệt); CORS chỉ dành cho dashboard.
- Tải APK: kiểm tra `X-Checksum-Sha256` trước khi ghi đè file đích.

## Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| `HTTP 401 invalid_management_key` | Key sai hoặc đã đổi. `testflight login` lại (server đọc key mới ngay, không cần restart). |
| `HTTP 503 management_key_not_configured` | Server chưa có `data/config.json`; khởi động server một lần. |
| `HTTP 409 version_exists` | Version đã tồn tại; dùng `--version` mới hoặc `--force`. |
| `HTTP 413 payload_too_large` | APK vượt `MAX_APK_BYTES` của server (mặc định 512 MiB) hoặc icon > 2 MiB. |
| `Cannot reach …` | Sai base URL, server chưa chạy, hoặc firewall. Thử `testflight doctor`. |
| `No MyTestflight server is configured` | Chưa `login` và chưa có env; xem lại phần cấu hình. |
| `Both "a.apk" and "b.apk" resolve to ABI …` | Hai APK cùng ABI; truyền `--abi` rõ ràng hoặc bỏ một file. |
| `Refusing to overwrite …` | File tải về đã tồn tại; thêm `--force` hoặc `--out`. |
| `Checksum mismatch` | File tải hỏng đã bị xoá; tải lại, nếu vẫn lỗi hãy upload lại APK. |
| Không màu khi pipe | Bình thường: màu chỉ bật trên TTY và khi không có `NO_COLOR`. |
| `Unsupported engine` | Node < 22; dùng Node 22+. |

## Giấy phép

MIT — xem [LICENSE](LICENSE).
