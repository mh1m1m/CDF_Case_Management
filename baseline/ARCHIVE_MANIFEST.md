# Baseline Archive Manifest

The baseline originals are reference material and are **not committed** (they embed ~430 KB of base64 imagery). They remain in the project's shared files. Verify any copy against these hashes before relying on it.

| File | Bytes | SHA-256 |
|---|---|---|
| CDF_Case_Platform_Local_Package.zip | 425,374 | (container; contents below) |
| CDF_Case_Platform.html | 803,116 | `51bb3aad945752546d2dedb10ee5854c1249a349f3e8e584aa8b0ee892720f60` |
| CDF_Local_Server.ps1 | 7,915 | `6a5199f02c5e9f36b6efe6d9b9ea3699d4aa745dfe9ed720a19cbe9ca5bfacd2` |
| Start_CDF_Platform.cmd | 366 | `8a3c94be32620748d0a8d01eff9ded6531573d18769d8455e6306f195cbc234b` |
| README_CDF_Local_Launcher_AR.txt | 4,162 | `e6cc03ce1ddcdc53aeb04d33171e2ca10f904af6bd9a9d6e38e013305f8e8f96` |
| Embedded logo (PNG 800×420) | 102,904 | `f8c25424eaecb66dc2d37f5306b290bb477c3963144381f76be9fbc39c064180` |

The HTML hash matches the `applicationSha256` recorded in `CDF_Design_Tokens.json` and in the UI/UX re-architecture report.

## Extraction

`baseline/extracted/baseline-domain.json` was produced by evaluating only the configuration object literals of the formatted application script (`CFG`, `ENTERPRISE_ROLES`, `ENTERPRISE_ROLE_PERMISSIONS`, `ENTERPRISE_FORM_ENTITLEMENTS`) in an isolated `vm` context. No baseline code is executed by this repository.

Contents: 19 form definitions (184 fields), the 19-step workflow table, 8 source references (titles only), 10 Arabic email templates, 3 SOURCE_REQUIRED keys, default configuration, 22 roles, role→permission map, per-form view/edit entitlements.
