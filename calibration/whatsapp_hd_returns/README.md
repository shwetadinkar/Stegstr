# WhatsApp HD send — measured 2026-09-07

| file | geometry | EXIF orientation | luma table (min/max/mean) | zigzag 1–6 |
|---|---|---|---|---|
| `wa_hd.jpeg` (sent) | 3840×2160 | **6** | 2 / 24 / 11.5 | 3,2,2,3,5,8 |
| `ret_wa_hd.jpg` (returned) | **2160×3840** | **none** | 4 / 19 / 12.2 | 4,5,9,9,10,11 |

Neither file carries a Stegstr payload — these were shot to measure the
channel, not to round-trip a message. What they establish is geometry, table
and orientation handling.

## Geometry: the long edge is preserved

3840 in, 3840 out. An HD send does not downscale, which is the difference from
a standard send: the same pipeline caps a 4096×3072 upload at 1600×1200
(`calibration/returns/whatsapp/chart_w4096.jpg`). That gap is why
`whatsapp_hd` is a separate profile and why choosing wrong is a total loss
rather than a degradation.

## The table is distinct from the standard send

Standard send quantizes at 6 / 167 / 35.6 with the embedding band at
6,6,6,7,10,15. HD quantizes at 4 / 19 / 12.2, band 4,5,9,9,10,11 — finer
everywhere and dramatically finer at high frequency. Confirmed across two
different geometries, so it is the send mode that selects the table, not the
image size.

## WhatsApp applies EXIF orientation physically

The upload was 3840×2160 with `orientation=6`, meaning "rotate 90° clockwise
to display". It came back **2160×3840 with no orientation tag**: WhatsApp
rasterised the rotation and dropped the flag.

A 90° rotation is not a degradation of a payload, it is the end of one — the
8×8 grid is transposed, so the decoder reads coefficients that were never
written. Measured on this encoder: an upright stego image decodes and the same
image rotated 90° recovers nothing.

**This encoder is not exposed.** It rasterises the cover through the same
orientation-applying path and writes output through canvas, which emits no
EXIF — so what leaves is already upright with no flag, and WhatsApp has
nothing left to act on. That is now held open by
`src/__tests__/exif-orientation.test.ts`, which asserts a cover marked
`orientation=6` comes out with its axes swapped and no EXIF segment, and
separately that a 90° rotation does destroy a payload.

Without that property, every payload sent to WhatsApp from a portrait phone
photo would die silently, and the failure would look like "the recipient's app
finds nothing" rather than anything pointing at orientation.
