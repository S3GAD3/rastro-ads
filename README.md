# RASTRO-ADS

RASTRO-ADS es una extensión para navegadores Chromium que ayuda a documentar indicios técnicos de monetización, analítica y publicidad en una página web. Su objetivo es que un investigador, aunque no sea especialista en tecnología publicitaria, pueda localizar identificadores útiles, entender qué significan y preparar una solicitud oficial dirigida al proveedor adecuado.

**Versión:** 0.7.0  
**Autor:** S3GAD3  
**Licencia:** MIT

> RASTRO-ADS no identifica por sí sola a una persona. Obtiene pivotes técnicos que pueden permitir a una autoridad competente solicitar a Google, Meta, TikTok, Microsoft u otro proveedor los datos que conserve y que legalmente pueda facilitar.
>
> Puede descargarla en el apartado "releases": https://github.com/S3GAD3/rastro-ads/releases

## Qué problema resuelve

Una web puede mostrar anuncios o cargar etiquetas de medición sin revelar públicamente quién la administra. Esas integraciones suelen contener identificadores asignados por plataformas externas. RASTRO-ADS los reúne, conserva su procedencia y los separa según su valor investigativo:

| Hallazgo | Ejemplo | Utilidad principal |
|---|---|---|
| Cuenta publicitaria Google | `pub-123…`, `ca-pub-123…` | Pivote prioritario para investigar la cuenta que monetiza la web |
| Declaración `ads.txt` | `google.com, pub-123…, DIRECT` | Relaciona públicamente el dominio con una cuenta autorizada para vender su inventario |
| Google Analytics | `G-…`, `UA-…` | Pivote de medición y posible administración; no demuestra quién cobra |
| Google Tag Manager | `GTM-…` | Pivote de gestión de etiquetas; puede conectar varias webs o servicios |
| Meta Pixel | identificador numérico | Pivote ante Meta para una cuenta o activo publicitario relacionado |
| TikTok Pixel | identificador alfanumérico | Pivote ante TikTok para una cuenta o activo publicitario relacionado |
| Microsoft UET | identificador de etiqueta | Pivote ante Microsoft Advertising |
| Contactos, IBAN o wallets | valor observado | Pistas OSINT que requieren validación independiente |

La distinción esencial es esta: una **pub-ID** puede estar relacionada con la monetización y el pago; Analytics, GTM y los píxeles suelen acreditar medición o administración técnica, pero no deben presentarse automáticamente como identificadores del beneficiario.

## Funciones

- Detecta cuentas Google `pub-…`, `ca-pub-…` y `host-pub-…`.
- Distingue identificadores observados, declaraciones `DIRECT` y relaciones `RESELLER`.
- Consulta `ads.txt`, `app-ads.txt` y el registro público `sellers.json` de Google.
- Localiza Google Analytics, Google Tag Manager, Site Verification, Meta Pixel, TikTok Pixel, Microsoft/Bing UET, Hotjar y Yandex Metrica.
- Conserva el origen del hallazgo: DOM, recurso, tráfico o declaración pública.
- Ordena las pub-ID según su utilidad para investigar al posible beneficiario de la monetización.
- Extrae contactos explícitos, IBAN válidos y candidatos a wallets como pivotes OSINT.
- Ofrece una consulta opcional a VirusTotal usando la clave del usuario.
- Exporta informes TXT/HTML y un paquete ZIP con manifiesto y hashes SHA-256.
- No incorpora telemetría, servidor propio ni dependencias JavaScript de ejecución.

## Instalación para cualquier investigador

### Desde una versión publicada

1. Descargue `RASTRO-ADS-v0.7.0-extension.zip` desde **Releases**.
2. Extraiga el ZIP en una carpeta estable.
3. Abra `chrome://extensions`, `edge://extensions` o `brave://extensions`.
4. Active **Modo de desarrollador**.
5. Pulse **Cargar descomprimida** y seleccione la carpeta que contiene `manifest.json`.
6. Fije RASTRO-ADS en la barra del navegador.

También puede clonar o descargar el repositorio y cargar su carpeta raíz. No se necesita compilar ni instalar dependencias.

## Uso paso a paso

1. Documente la URL, fecha, hora, zona horaria y contexto del caso.
2. Abra la URL investigada.
3. Abra RASTRO-ADS y pulse **Recargar y capturar**.
4. Espere a que la insignia muestre `LISTO`.
5. Abra de nuevo la extensión y pulse **Analizar**.
6. Revise primero **Resumen** y **Atribución**.
7. Compruebe `ads.txt`, los pivotes OSINT y la matriz por proveedor.
8. Exporte el informe y, si necesita preservar artefactos, genere el paquete de evidencia.

**Analizar** sin recargar examina el estado disponible, pero puede perder solicitudes de red anteriores. Para una captura reproducible se recomienda **Recargar y capturar**.

## Cómo interpretar la atribución

1. **Observado + DIRECT:** la cuenta apareció en la carga y el dominio la declara como relación directa. Es el pivote inicial más sólido.
2. **Observado sin DIRECT:** apareció en la página o el tráfico, pero falta una declaración directa coincidente.
3. **DIRECT no observado:** el dominio la declara, aunque no apareció durante esa captura. Puede ser una integración inactiva, condicionada o histórica.
4. **RESELLER:** normalmente indica intermediación. No debe atribuirse al editor o beneficiario sin corroboración.

Varias apariciones del mismo identificador no equivalen necesariamente a varias fuentes independientes. Revise siempre la procedencia y el contexto original.

## Qué pedir a cada proveedor

La pestaña **Oficial** genera orientación adaptable. Siempre que exista habilitación legal, competencia, necesidad y proporcionalidad, puede valorarse solicitar:

- identificación de la cuenta asociada al identificador y sus IDs internos;
- datos de alta, verificación y cambios relevantes;
- contactos y medios de recuperación;
- administradores, usuarios autorizados y cuentas o activos relacionados;
- métodos y beneficiarios de pago, perfil de pagos, transacciones e importes;
- fechas de acceso, direcciones IP y dispositivos dentro del periodo investigado;
- conservación urgente de datos, cuando proceda;
- explicación técnica de la relación entre el identificador aportado y la cuenta.

Para Google, una pub-ID es normalmente el pivote de monetización prioritario. Analytics y GTM son complementarios. Para Meta, TikTok y Microsoft, el píxel o etiqueta permite pedir la cuenta publicitaria o empresarial relacionada y sus administradores. La disponibilidad depende del proveedor, producto, periodo, jurisdicción y política de conservación.

Incluya el identificador exacto, URL, dominio, fecha/hora con zona, forma de observación y periodo relevante. Revise y adapte siempre el texto generado: RASTRO-ADS no crea por sí misma un requerimiento jurídico válido.

## Valor probatorio y límites

Los resultados son **indicios técnicos**, no una conclusión automática. No demuestran por sí solos identidad civil, control actual del dominio, titularidad bancaria, cobro efectivo, importe obtenido o vigencia de la relación.

Corrobore con otras fuentes y conserve la cadena de custodia conforme a sus procedimientos. Los hashes SHA-256 permiten detectar cambios posteriores, pero no acreditan por sí solos autoría, autenticidad, licitud de obtención o fecha real. La extensión no aplica firma digital ni sello de tiempo cualificado.

La guía [Guía del investigador](docs/GUIA-DEL-INVESTIGADOR.md) explica la técnica, el flujo de trabajo y los errores de interpretación más frecuentes.

## Paquete de evidencia

El ZIP de evidencia puede incluir DOM, metadatos, tráfico disponible, declaraciones públicas, resultados, notas y advertencias. `manifest.json` relaciona cada archivo con su SHA-256 y `manifest.sha256` permite verificar el manifiesto. El `ads.txt` completo se conserva aparte del resumen interpretado.

## Privacidad y permisos

La captura se activa para la pestaña cuya recarga inicia expresamente el usuario. RASTRO-ADS no captura cabeceras HTTP, cookies, contraseñas ni contenido de autenticación. No transmite las investigaciones a un servidor del autor.

El permiso de sitios es amplio porque una página puede cargar publicidad y píxeles desde muchos dominios y porque se consultan archivos públicos relacionados con el objetivo. Use un perfil dedicado, cierre sesiones personales y no analice páginas con datos privados ajenos salvo autorización. Consulte [PRIVACY.md](PRIVACY.md).

## VirusTotal

La integración es opcional y no incluye una API key. El dominio solo se envía a VirusTotal cuando el usuario activa la función e inicia la consulta. La API pública gratuita tiene límites y restricciones, entre ellas la prohibición de usarla en productos comerciales y en ciertos flujos profesionales. Cada organización debe disponer de una modalidad compatible. RASTRO-ADS no concede derechos de uso sobre ese servicio.

## Desarrollo y comprobación

Node.js solo es necesario para las pruebas; la extensión no lo usa en el navegador.

```bash
npm test
npm run check
```

```text
manifest.json          Configuración Manifest V3
background.js          Captura limitada de tráfico y estado de sesión
content.js             Observación del documento y recursos
popup.*                Interfaz, análisis y exportación
src/lib/               Parsers y utilidades sin dependencias externas
tests/                 Pruebas automatizadas
docs/                  Guías de investigación y publicación
```

Lea [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) y la [lista de publicación](docs/PUBLICACION-EN-GITHUB.md).

## Uso responsable, licencia y marcas

Utilice la herramienta en páginas públicas, sistemas propios o escenarios autorizados. Respete la legislación, las normas de su organización, los términos de los servicios y los derechos de terceros. No la use para acceder a cuentas, obtener credenciales, eludir controles o interferir con servicios.

El código y documentación originales se distribuyen bajo [licencia MIT](LICENSE). Los servicios, marcas, especificaciones y datos de terceros conservan sus propios términos. Google, Meta, TikTok, Microsoft, IAB Tech Lab y VirusTotal no patrocinan, certifican ni mantienen el proyecto. Consulte [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
