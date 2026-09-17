# Registro de cambios

## 0.7.0 — 2026-09-17

- Crea una clasificación operativa de `pub-ID` para investigar al posible beneficiario de la monetización.
- Prioriza `OBSERVADO + DIRECT`, después observado sin DIRECT y finalmente DIRECT no observado con titular público.
- Excluye los RESELLER puros de la matriz principal y de la ficha policial individualizada.
- Evita elevar la confianza por varias líneas o recursos de una misma clase de fuente.
- Detecta y señala IDs declaradas simultáneamente como DIRECT y RESELLER.
- Registra si el análisis se realizó con captura/recarga o de forma inmediata.
- Explica expresamente cuándo la ausencia de tráfico limita la conclusión.
- Consolida Analytics, GTM y píxeles desde DOM, recursos y tráfico.
- Diferencia IDs de monetización de pivotes de administración, medición o publicidad.
- Reduce el TXT: sustituye el `ads.txt` completo por un anexo relevante.
- Conserva el `ads.txt` íntegro y añade `ads-prioritarios.txt` en el paquete de evidencia.
- Mejora el contexto de origen de las pub-ID y elimina etiquetas de confianza en inglés.

## 0.6.0 — 2026-09-15

- Limita la captura de tráfico y marcos a la pestaña iniciada expresamente por el investigador.
- Elimina la captura de cabeceras HTTP y cookies.
- Redacta parámetros sensibles antes de conservar una URL observada.
- Añade detección de tráfico para Meta Pixel, TikTok Pixel, Bing UET, Hotjar y Yandex Metrica.
- Añade una matriz por proveedor con identificador, procedencia y confianza técnica.
- Añade orientación diferenciada para solicitudes a Google, Meta, TikTok y Microsoft.
- Incorpora una sonda limitada del contexto principal para unidades GPT y Prebid.
- Reduce el informe guardado en modo sesión y excluye el DOM completo de esa persistencia.
- Limita a 2,5 MB las descargas de `ads.txt` y `app-ads.txt`.
- Endurece la validación de `ads.txt` y registra líneas defectuosas o duplicadas.
- Endurece el lector ZIP con límites, CRC-32, comprobación de truncado, rutas y duplicados.
- Evita capturar un DOM de evidencia si la pestaña cambió de URL desde el análisis.
- Añade pruebas automatizadas y documentación de licencia, privacidad y terceros.
