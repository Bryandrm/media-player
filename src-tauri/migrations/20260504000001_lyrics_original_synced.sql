-- Backup del LRC original para no corromperlo en re-alignments sucesivos.
--
-- Bug que motivó esta migración: cuando hacíamos RE-ALIGN, leíamos
-- `synced_lyrics` que YA contenía A2 (timestamps por palabra) del align
-- previo, posiblemente broken. El cascade extraía los line markers de ahí
-- y los usaba como bounds para whisperx — perpetuando el error.
--
-- Patrón mirror de `tracks.original_title` / `original_artist`: guardamos
-- el LRC raw que vino de LRCLIB la primera vez y siempre alineamos contra
-- esa fuente de verdad.

ALTER TABLE lyrics ADD COLUMN original_synced_lyrics TEXT;
