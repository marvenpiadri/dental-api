# File storage (Cloudflare R2)

One service stores every uploaded file: patient documents, X-rays, clinical photos, lab attachments, patient/staff/dentist pictures, product images. New modules add a line to `src/files/purposes.ts`; they do not write upload code.

## Flow

1. `POST /v1/files` `{purpose, name, contentType, size, patientId | labOrderId | subjectId}`. The API checks permission, type, size cap and that the owner exists **in this clinic**, stores a `pending` row and returns a 10-minute signed PUT URL.
2. The browser PUTs the bytes **straight to R2**. Nothing large passes through the Worker (all API bodies are capped at 64 KB).
3. `POST /v1/files/:id/complete`. The API checks in the bucket that size and type match what was declared and that the first bytes are really that type (PDF, JPEG, PNG, WebP, DICOM). Only then the file is `ready` and attached. A bad upload is deleted. Safe to retry.
4. `GET /v1/files/:id/content` authorizes, then redirects (302) to a 60-second signed read URL. Images display inline, everything else downloads.

Keys are `<clinicId>/<purpose>/<random id>`: no patient data, not guessable. Reads and writes use the S3 API with signed URLs; the bucket has **no public URL**.

| Purpose | Attaches to | Retention |
|---|---|---|
| patient_document, xray, clinical_image | patient | clinical: void only, never deleted |
| lab_attachment | lab order (+ its patient) | clinical: void only |
| patient_photo, staff_photo, dentist_photo, product_image | `photo_file_id` on the owner row | replaced or removed = bytes deleted |

Replacing a picture voids the old file and deletes its bytes. An hourly cron (`purgeFiles`) removes abandoned uploads and any bytes a failed delete left behind. Clinical files are never purged. `GET /v1/files/purposes` tells the browser the allowed types, size caps and which purposes must not be re-encoded (`lossless`: X-rays and clinical images).

## Configuration (never in the repository)

| Name | Where |
|---|---|
| `R2_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`, bucket suffix allowed) | `.dev.vars` / `wrangler secret put R2_ENDPOINT` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | `.dev.vars` / `wrangler secret put` |
| `R2_BUCKET` (`dontalist`) | `wrangler.jsonc` vars |

Use an R2 API token limited to **Object Read & Write on this one bucket**. The Worker holds it; the browser only ever sees short-lived signed URLs.

## Owner setup (one time)

1. **Bucket CORS** (browsers PUT and GET directly). Dashboard > R2 > dontalist > Settings > CORS policy:
```json
[{ "AllowedOrigins": ["https://app.dontalist.com", "http://localhost:4200"], "AllowedMethods": ["GET", "PUT", "HEAD"], "AllowedHeaders": ["Content-Type"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```
2. **Turn the public development URL (`pub-….r2.dev`) OFF.** It exposes every object in the bucket to anyone who knows a key. This bucket holds private clinical files; nothing here uses it. If public assets are ever needed (a logo, say), use a separate bucket.
3. Run `npm run r2-smoke` from a machine that can reach R2. It signs, uploads, reads, refuses unsigned access, checks CORS and cleans up.
4. Rotate the R2 token if it was ever pasted into a chat or ticket.

## What is and is not verified

- Verified in tests: authorization, clinic isolation, size/type/magic-byte checks, retention, replacement, purge, concurrency (PostgreSQL); our signed URLs against an independent SigV4-validating server over real HTTP (`files.s3.test.ts`).
- Not verified here: Cloudflare R2 itself (the sandbox cannot reach it). Two behaviours depend on R2 and are checked by `r2-smoke`: that it honours the signed `Content-Type`, and `response-content-disposition` on reads.
- A signed PUT cannot cap the byte count, so an authorized user can upload more than declared. `complete` rejects and deletes it, and the purge catches anything never completed. The R2 token must not be able to do more than read/write this bucket.
