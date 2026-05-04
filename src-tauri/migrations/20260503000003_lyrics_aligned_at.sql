-- Karaoke Fase A: tracking de cuándo corrimos forced alignment.
--
-- A2-formatted LRC vive inline en `lyrics.synced_lyrics` (los timestamps por
-- palabra `<mm:ss.xx>word` son backward-compatible con LRC estándar). Ver
-- docs/KARAOKE.md §4.
--
-- `aligned_at` no NULL = ya hay timestamps por palabra en synced_lyrics.
-- Útil para:
--   - Cambiar el botón AUTO-ALIGN a RE-ALIGN cuando ya está alineado.
--   - Mostrar tooltip con la fecha del último alignment.
--   - No re-correr automáticamente (alignment es lento, ~30s-2min).

ALTER TABLE lyrics ADD COLUMN aligned_at DATETIME;
