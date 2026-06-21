-- Persistencia del resultado de CHECK QUALITY (mismatch detection).
-- Antes vivía sólo en memoria (lyricsStore.mismatchResult) → al cerrar la app
-- o cambiar de track se perdía. Con estas columnas la app recuerda que ya se
-- corrió quality en una canción y con qué score.
--   mismatch_score:      overall_score (0..1) de la última corrida. NULL = nunca.
--   mismatch_checked_at: timestamp de esa corrida. NULL = nunca chequeado.
-- Se resetean a NULL cuando el texto del LRC cambia (refetch / manual edit),
-- porque un score viejo no aplica a una letra nueva.
ALTER TABLE lyrics ADD COLUMN mismatch_score REAL;
ALTER TABLE lyrics ADD COLUMN mismatch_checked_at TEXT;
