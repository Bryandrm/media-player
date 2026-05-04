-- Persist el score numérico de AcoustID además del status categórico.
--
-- Hasta ahora guardábamos sólo `identification_status` (identified /
-- low_confidence / no_match / etc) — el status es una decisión binaria
-- contra el threshold (0.80) pero perdíamos el score real (ej 0.82, 0.97).
--
-- Útil para:
--   - Tooltip en el indicador [ID] mostrando el score exacto.
--   - Decidir empíricamente si subir/bajar el threshold (ver distribución
--     de scores en library del usuario).
--   - Debug de matches sospechosos (score alto pero metadata equivocada).
--
-- NULL para todos los tracks identified ANTES de esta migración — no es
-- un problema: la información existió en eprintln logs pero no es
-- recuperable retroactivamente. Tracks que se re-identifiquen tendrán el
-- score poblado.

ALTER TABLE tracks ADD COLUMN acoustid_score REAL;
