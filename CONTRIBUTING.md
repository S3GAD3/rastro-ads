# Contribuir a RASTRO-ADS

El proyecto prioriza exactitud, trazabilidad, minimización de datos y explicaciones comprensibles para investigadores no técnicos.

## Antes de proponer un cambio

- Abra un issue para errores reproducibles o mejoras.
- No publique dominios investigados, API keys, credenciales, cookies, datos personales ni evidencia de casos reales.
- Para vulnerabilidades, siga `SECURITY.md` y evite un issue público.
- Compruebe que puede licenciar su contribución bajo MIT.

## Pruebas

```bash
npm test
npm run check
```

Después, cargue el repositorio como extensión descomprimida y verifique análisis inmediato, captura con recarga, exportaciones y ausencia de secretos sin redactar.

## Criterios de diseño

- No presentar Analytics, GTM o píxeles como prueba automática de cobro.
- No elevar confianza por repeticiones de una misma clase de fuente.
- Mantener el texto oficial como orientación revisable, no asesoramiento jurídico.
- Evitar dependencias remotas, telemetría y recopilación innecesaria.
- Documentar y justificar cualquier permiso nuevo.

Indique en cada pull request la finalidad, pruebas realizadas y, si cambia la interfaz o el informe, un ejemplo anonimizado.
