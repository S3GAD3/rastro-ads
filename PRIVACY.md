# Política de privacidad de RASTRO-ADS

Última actualización: 15 de septiembre de 2026.

## Resumen

RASTRO-ADS procesa localmente la página que el usuario decide investigar. No existe una cuenta RASTRO-ADS, servidor del desarrollador, telemetría, publicidad ni venta de datos.

## Datos tratados

Al iniciar un análisis, la extensión puede procesar en el dispositivo:

- URL, dominio, título y DOM de la pestaña investigada;
- scripts, recursos y marcos relacionados con publicidad o medición;
- URL, método, tipo, iniciador, estado y hora de determinadas peticiones publicitarias;
- identificadores publicitarios, analíticos y de seguimiento;
- contactos, IBAN y candidatos a direcciones de criptomonedas presentes en la página;
- archivos públicos `ads.txt`, `app-ads.txt` y registros relevantes de `sellers.json`;
- notas introducidas voluntariamente por el usuario.

RASTRO-ADS no solicita ni captura cabeceras HTTP, cookies o contraseñas. Los parámetros de URL con nombres sensibles, como tokens, claves o identificadores de sesión, se sustituyen antes de mostrarse o exportarse.

## Inicio y alcance de la captura

La observación de tráfico solamente conserva datos cuando el usuario pulsa **Recargar y capturar**, y queda limitada al identificador de esa pestaña. Una navegación ordinaria no ejecuta el análisis del documento. La captura termina al analizar, comenzar una nueva investigación o cerrar la pestaña.

## Conservación local

- **Modo efímero:** los resultados permanecen en memoria mientras el popup está abierto.
- **Modo sesión:** se conserva un informe estructurado reducido en `chrome.storage.session` hasta que termina la sesión del navegador o el usuario lo borra.

El HTML completo no se guarda en el informe restaurable de sesión. Las exportaciones solo se crean cuando el usuario pulsa el botón correspondiente y se guardan donde el navegador determine.

## Comunicaciones externas

Para ofrecer la funcionalidad solicitada, la extensión puede consultar directamente:

- `ads.txt` o `app-ads.txt` del dominio investigado;
- `sellers.json` público de Google;
- VirusTotal, únicamente cuando el usuario activa la integración e inicia una consulta.

En la consulta opcional de VirusTotal se transmite el dominio investigado a VirusTotal y se utiliza la API key proporcionada por el usuario. La clave no se exporta ni se envía al desarrollador de RASTRO-ADS.

## Control del usuario

El usuario puede borrar el estado actual mediante **Nueva investigación**, cerrar el navegador para finalizar el almacenamiento de sesión, evitar VirusTotal o desmarcar artefactos antes de generar evidencia.

## Terceros

Las consultas externas quedan sujetas a las políticas y condiciones de los proveedores correspondientes. Esta política describe el comportamiento de RASTRO-ADS, no el tratamiento independiente realizado por esos proveedores.

## Contacto

Las incidencias de privacidad pueden comunicarse mediante el sistema de issues del repositorio oficial del proyecto.

