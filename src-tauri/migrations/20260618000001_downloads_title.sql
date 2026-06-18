-- History persistente de descargas (ADR-011 chunk 2). La tabla `downloads`
-- existe desde Fase 0 pero no se venía persistiendo (el download_id era un
-- contador en memoria). Falta `title` para mostrar el nombre en el historial
-- — el contrato `Download` ya lo tiene. Aditivo, nullable.
ALTER TABLE downloads ADD COLUMN title TEXT;
