-- Smart playlists: playlists cuyos tracks se derivan de reglas en vez de una
-- lista manual. `is_smart=1` marca la playlist como smart; `rules` guarda el
-- JSON de las condiciones (match all/any + array de {field, op, value}).
-- Una smart playlist no tiene filas en `playlist_tracks` — sus tracks se
-- evalúan dinámicamente. Las playlists normales existentes quedan is_smart=0.

ALTER TABLE playlists ADD COLUMN is_smart INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN rules TEXT;
