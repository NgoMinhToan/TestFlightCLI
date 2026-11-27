# CI, phát triển và xử lý sự cố

## JSON và exit code

- `--json` in **một** object JSON ra stdout; log và thanh tiến trình bị tắt. Cảnh báo vẫn ở stderr.
- Lỗi luôn ở stderr, dạng `error: …` và `hint: …`.
- Exit code:

| Code | Nghĩa |
|---|---|
| `0` | Thành công |
| `1` | Lỗi server, mạng, file APK không đọc được, hoặc kiểm tra (`doctor`, `apk inspect`) |
| `2` | Sai cú pháp, flag hoặc tham số |
| `130` | Bị huỷ (`Ctrl+C`) |

Ví dụ đọc kết quả trong CI:

```bash
testflight release crm app.apk --version 1.4.2 --version-code 142 --json > release.json
node -p "require('./release.json').version.abis.join(',')"
```

## GitHub Actions

```yaml
- name: Publish to MyTestflight
  # First publish of a version needs no --force; re-running the same version does.
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

Kiểm tra kết nối/key trước khi phát hành:

```bash
testflight doctor --json
```

## CI/CD của package

- [`ci.yml`](../.github/workflows/ci.yml): mọi push/PR → `typecheck`, test, build, smoke test trên
  Node 22 và 24.
- [`publish.yml`](../.github/workflows/publish.yml): push tag `v*` → kiểm tra tag khớp
  `package.json` → test/build → `npm publish --provenance` → tạo GitHub Release.

Phát hành phiên bản mới:

```bash
npm version patch          # hoặc minor / major; tạo commit + tag vX.Y.Z
git push --follow-tags
```

Cấu hình một lần trên GitHub:

1. Tạo npm access token có quyền publish package `my-testflight-cli`.
2. Thêm repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. (Tuỳ chọn) Dùng **npm trusted publishing** thay token: khai báo repo + workflow `publish.yml`
   trên npmjs.com, rồi bỏ `NODE_AUTH_TOKEN` khỏi bước publish. Workflow đã có `id-token: write`.

`--provenance` tạo attestation SLSA gắn với commit/tag GitHub. Nếu repo đổi owner/tên, cập nhật
`repository` trong `package.json` để attestation trỏ đúng nguồn.

## Phát triển

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

- **Unit test** (`test/*.test.ts`): `node --test` + `tsx`, không cần server thật.
- **Fake server** (`test/fake-server.ts`): mô phỏng API, auth, upload, `POST /api/v1/import`, suy
  ABI, verify metadata, `allow_mismatch`, download và checksum.
- **CLI end-to-end** (`test/cli.test.ts`, `test/publish.test.ts`): spawn `src/cli.ts`, chạy trọn
  luồng login → create → release → publish → inspect → download → force.
- **Fixture APK** (`test/zip-fixture.ts`): tạo ZIP stored/deflate và AXML UTF-8/UTF-16 hợp lệ, kèm
  `writeFakeApk(dir, file, abis, metadata?)`.
- **Fixture thật** (`test/fixtures/manifest.axml.b64`): manifest 8 000 byte lấy từ APK trong
  workspace, dùng chung hợp đồng với server và dashboard. Không commit APK thật.
- `test/apk-manifest.test.ts` kiểm tra parser: fixture thật, stored/deflate, UTF-8/UTF-16,
  reference `versionName`, codename SDK (→ null), config split, ZIP64, manifest hỏng và giới hạn
  16 MiB/8 MiB.

```text
TestFlightCLI/
├── src/
│   ├── cli.ts, run.ts          # entry, dispatch, exit code
│   ├── api.ts                  # client + upload/download stream
│   ├── config.ts               # profile, config 0600, thứ tự ưu tiên
│   ├── args.ts, output.ts      # parseArgs, bảng/màu/JSON/tiến trình
│   ├── apk.ts, abi.ts, plan.ts # đọc ABI trong APK, kế hoạch release
│   ├── help.ts, prompt.ts
│   └── commands/               # setup, apps, versions, release, download, artifacts
├── test/                       # unit + fake server + CLI e2e
├── docs/                       # tài liệu tham chiếu
└── .github/workflows/          # ci.yml, publish.yml
```

## Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| `HTTP 401 invalid_management_key` | Key sai hoặc đã đổi. Chạy lại `testflight login`; server đọc key mới ngay, không cần restart. |
| `HTTP 503 management_key_not_configured` | Server chưa có `data/config.json`; khởi động server một lần. |
| `HTTP 409 version_exists` | Version đã tồn tại; dùng `--version` mới hoặc `--force`. |
| `HTTP 413 payload_too_large` | APK vượt `MAX_APK_BYTES` của server (mặc định 512 MiB) hoặc icon > 2 MiB. |
| `HTTP 400 invalid_apk` | File không phải ZIP/APK, thiếu hoặc hỏng `AndroidManifest.xml`, dùng ZIP64, hoặc là config split. Kiểm tra bằng `testflight apk inspect <file>`. |
| `HTTP 422 apk_metadata_mismatch` | Package/version/minSdk/ABI trong APK lệch app/version đích. Sửa build, hoặc thêm `--allow-mismatch package,version,sdk,abi` khi thật sự chủ ý. |
| `HTTP 404 not_found` từ `publish` | Server chưa có `POST /api/v1/import`; nâng cấp MyTestflightServer hoặc dùng `release` với các route artifact cũ. |
| `Cannot read AndroidManifest.xml …` | Manifest hỏng hoặc ZIP64; CLI vẫn suy ABI từ tên file nhưng server sẽ từ chối. Dùng `apk inspect` để xem chi tiết. |
| `Cannot reach …` | Sai base URL, server chưa chạy hoặc firewall. Thử `testflight doctor`. |
| `No MyTestflight server is configured` | Chưa `login` và chưa có biến môi trường; xem [Cấu hình](./configuration.md). |
| `Both "a.apk" and "b.apk" resolve to ABI …` | Hai APK cùng ABI; truyền `--abi` rõ ràng hoặc bỏ một file. |
| `Refusing to overwrite …` | File tải về đã tồn tại; thêm `--force` hoặc chọn `--out` khác. |
| `Checksum mismatch` | File tải hỏng đã bị xoá; tải lại, nếu vẫn lỗi hãy upload lại APK. |
| Không có màu khi pipe | Bình thường: màu chỉ bật trên TTY và khi không đặt `NO_COLOR`. |
| `Unsupported engine` | Node < 22; nâng lên Node 22+. |

Khi báo lỗi, chạy lại với `--verbose` để có stack trace.
