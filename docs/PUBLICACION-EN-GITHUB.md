# Lista de publicación en GitHub

## Crear el repositorio

1. Cree un repositorio público, por ejemplo `rastro-ads`.
2. No añada automáticamente README, licencia ni `.gitignore`: ya están incluidos.
3. Suba el contenido de la carpeta raíz, no el ZIP instalable como sustituto del código.
4. Active **Issues** y, si es posible, **Private vulnerability reporting**.
5. Añada una descripción y temas como `osint`, `browser-extension`, `adtech`, `digital-forensics` e `investigation`.

## Publicar la versión 0.7.0

1. Cree el tag `v0.7.0` sobre la revisión publicada.
2. Cree una Release titulada `RASTRO-ADS v0.7.0`.
3. Resuma los cambios usando `CHANGELOG.md`.
4. Adjunte `RASTRO-ADS-v0.7.0-extension.zip` como binario instalable.
5. Publique el SHA-256 del ZIP de la Release.

## Comprobaciones previas

- El autor posee los derechos del código, textos, logotipo e iconos.
- No hay API keys, dominios de casos reales, informes ni evidencias.
- `npm test` y `npm run check` finalizan correctamente.
- La versión coincide en `manifest.json`, `package.json`, README y changelog.
- La Release contiene exactamente la versión probada.
- Los avisos de privacidad, terceros, seguridad y licencia están visibles.

## Git inicial

```bash
git init
git add .
git commit -m "Publica RASTRO-ADS v0.7.0"
git branch -M main
git remote add origin URL_DEL_REPOSITORIO
git push -u origin main
git tag -a v0.7.0 -m "RASTRO-ADS v0.7.0"
git push origin v0.7.0
```

Sustituya `URL_DEL_REPOSITORIO` por la URL creada en GitHub. La publicación en Chrome Web Store es un proceso separado y exige revisar sus políticas, permisos y declaración de privacidad.
