-- Vincula una descarga de lista con la playlist que creó/reusó, para poder
-- expandirla en el historial y mostrar sus tracks. NULL para video suelto.
-- Sin FK explícita: si la playlist se borra, el id queda dangling y el
-- frontend lo maneja (expand devuelve vacío).
ALTER TABLE downloads ADD COLUMN playlist_id INTEGER;
