# Contribuciones a conda-forge

> Plan para crear feedstocks de paquetes que no existen en conda-forge.
> Retomar como proyecto separado cuando haya tiempo.

---

## Contexto

Durante la validacion de Pixi (ADR-037, 2026-06-20) descubrimos que dos
dependencias del proyecto **no tienen paquete en conda-forge**:

1. **Chromaprint / fpcalc** - audio fingerprinting (AcoustID)
2. **espeak-ng** - motor de fonemas (usado por phonemizer para mismatch detection)

Actualmente resolvemos esto bundleando los binarios pre-compilados como
recursos de Tauri. Crear feedstocks beneficiaria a toda la comunidad
conda-forge y eliminaria la necesidad del bundle manual.

---

## 1. Chromaprint (fpcalc)

### Que es
Libreria C++ que genera fingerprints acusticos. El binario CLI `fpcalc`
es el que usamos. Proyecto de Lukas Lalinsky (mismo autor de AcoustID
y MusicBrainz Picard).

### Estado actual
- **Repo:** https://github.com/acoustid/chromaprint
- **Licencia:** LGPL 2.1
- **Build system:** CMake
- **Ultima release:** v1.5.1 (2022-01-02)
- **Deps:** FFmpeg (ya en conda-forge)
- **conda-forge:** NO existe feedstock (verificado 2026-06-20)
- **PyPI:** No aplica (es C++, no Python)

### Complejidad estimada: BAJA
- CMake estandar, sin dependencias exoticas
- FFmpeg ya tiene feedstock maduro en conda-forge
- Solo produce un binario (`fpcalc`) y una libreria (`libchromaprint`)
- Cross-platform sin problemas conocidos (builds oficiales para Win/Mac/Linux)

### Pasos para crear el feedstock
1. Fork `conda-forge/staged-recipes`
2. Crear `recipes/chromaprint/meta.yaml`:
   - Source: GitHub release tarball v1.5.1
   - Build: CMake (`cmake -DBUILD_TOOLS=ON`)
   - Host deps: `ffmpeg`, `cmake`, `make` (o `ninja`)
   - Run deps: `ffmpeg`
   - Test: `fpcalc -version`
3. PR a staged-recipes, esperar review del equipo conda-forge
4. Una vez mergeado, se auto-publica en `conda-forge` channel

### Recursos utiles
- Guia de contribucion: https://conda-forge.org/docs/maintainer/adding_pkgs/
- Template meta.yaml: https://github.com/conda-forge/staged-recipes/tree/main/recipes/example
- Feedstock de FFmpeg (referencia): https://github.com/conda-forge/ffmpeg-feedstock

---

## 2. espeak-ng

### Que es
Motor TTS (text-to-speech) open source que tambien funciona como
conversor texto-a-fonemas (IPA). Nosotros lo usamos exclusivamente
como backend de `phonemizer` para la deteccion de mismatch en karaoke.

### Estado actual
- **Repo:** https://github.com/espeak-ng/espeak-ng
- **Licencia:** GPL 3.0
- **Build system:** CMake (+ autotools legacy)
- **Ultima release:** 1.51 (2024)
- **Deps:** Ninguna significativa (standalone)
- **conda-forge:** NO existe feedstock (verificado 2026-06-20)
- **PyPI:** No aplica (es C, no Python)

### Complejidad estimada: MEDIA
- Build system mixto (CMake + autotools, migrando a CMake)
- Produce binario CLI (`espeak-ng`) + shared library (`libespeak-ng.so/.dll`)
- **Data files**: necesita empaquetar ~10MB de datos de voces y reglas
  foneticas que van en `share/espeak-ng-data/`
- La libreria busca los data files relativo a su ubicacion de instalacion;
  puede necesitar patchear el path en el recipe
- Windows: la DLL se instala en `Program Files\eSpeak NG\` por default,
  hay que ajustar el prefix para conda

### Pasos para crear el feedstock
1. Fork `conda-forge/staged-recipes`
2. Crear `recipes/espeak-ng/meta.yaml`:
   - Source: GitHub release tarball
   - Build: CMake (`cmake -DUSE_ASYNC=OFF -DBUILD_SHARED_LIBS=ON`)
   - Incluir data files en el package (`share/espeak-ng-data/`)
   - Test: `espeak-ng --version` + verificar que `libespeak-ng` carga
3. **Probar en las 3 plataformas** (Windows es la mas delicada por paths)
4. PR a staged-recipes

### Notas adicionales
- `phonemizer` (Python) busca la shared library, no el CLI. El feedstock
  necesita asegurar que `libespeak-ng.so` / `libespeak-ng.dll` quede en
  un path que phonemizer encuentre (o documentar `PHONEMIZER_ESPEAK_LIBRARY`)
- Si el feedstock de espeak-ng existe, phonemizer podria agregarlo como
  dep automatica (PR al feedstock de phonemizer, si llega a existir)

---

## Orden recomendado

1. **Chromaprint primero** - mas simple, menos riesgo, impacto inmediato
   (AcoustID es usado por muchos proyectos de audio)
2. **espeak-ng segundo** - mas complejo pero beneficia a todo el ecosistema
   NLP/TTS que usa phonemizer

---

## Checklist pre-contribucion

- [ ] Leer guia completa de conda-forge para maintainers
- [ ] Verificar que no aparecio un feedstock mientras tanto (`conda search`)
- [ ] Preparar entorno de build local (`conda-build`)
- [ ] Testear el recipe en al menos 2 plataformas antes del PR
- [ ] Ofrecerse como maintainer del feedstock (implica responder a issues)
