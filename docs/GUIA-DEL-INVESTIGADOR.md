# Guía breve para el investigador

## La idea en lenguaje sencillo

Una web anónima puede depender de empresas conocidas para mostrar anuncios, medir visitas o gestionar campañas. Esas empresas asignan códigos a sus clientes. Aunque el código visible no suele contener el nombre de una persona, puede servir como referencia precisa para que la autoridad competente pregunte al proveedor qué cuenta tenía asociada.

RASTRO-ADS busca esos códigos y documenta dónde aparecieron. La técnica no consiste en «descifrar» el identificador, sino en convertirlo en un pivote verificable para una solicitud posterior.

## Tres niveles de valor

### 1. Monetización

Las cuentas `pub-…` de Google son el hallazgo más directamente relacionado con la posibilidad de recibir ingresos publicitarios. Una coincidencia `DIRECT` en `ads.txt` refuerza que el dominio se presenta públicamente como vendedor directo mediante esa cuenta.

### 2. Administración y medición

Analytics, Tag Manager y los píxeles de Meta, TikTok o Microsoft permiten medir visitantes o gestionar campañas. Pueden conducir a cuentas con administradores y datos de alta, pero no significan necesariamente que esa cuenta reciba el dinero de los anuncios mostrados.

### 3. Corroboración OSINT

Correos, teléfonos, IBAN, wallets, dominios relacionados y coincidencias entre páginas pueden apoyar hipótesis. Deben comprobarse por separado y valorarse junto con las fechas y el contexto.

## Ejemplo mental

Si una web carga `ca-pub-123…` y su `ads.txt` declara `google.com, pub-123…, DIRECT`, el informe permite documentar que:

1. el identificador apareció en la integración técnica;
2. el propio dominio publicó una declaración coincidente;
3. Google es el proveedor al que dirigir el pivote;
4. todavía falta que Google confirme, por el cauce legal adecuado, la cuenta, el beneficiario y los pagos que conserve.

No debe escribirse «el propietario es X» solo por un nombre encontrado en `sellers.json`. Es una fuente pública útil, pero siguen siendo necesarias la confirmación oficial y la relación temporal.

## Procedimiento recomendado

1. Trabaje desde un perfil de navegador dedicado, sin cuentas personales abiertas.
2. Anote URL, fecha, hora, zona horaria y motivo de la captura.
3. Use **Recargar y capturar** para observar las solicitudes generadas al cargar.
4. Exporte el paquete de evidencia inmediatamente después del análisis.
5. Registre quién obtuvo el archivo, cuándo, dónde se custodió y sus copias.
6. Empiece por los hallazgos de monetización observados y `DIRECT`.
7. Use Analytics, GTM y píxeles como vías complementarias.
8. Adapte la solicitud al proveedor, producto, periodo y jurisdicción.
9. Corrobore la respuesta con dominio, hosting, pagos, registros societarios y demás evidencia lícita.

## Contenido de una solicitud útil

- identificador exacto y tipo de producto;
- URL y dominio donde fue observado;
- fecha, hora y zona horaria;
- intervalo temporal investigado;
- copia o resumen de la evidencia técnica y su hash;
- categorías concretas de datos solicitadas;
- petición de conservación, si procede;
- base jurídica, autoridad, firma y cauce exigidos.

Entre las categorías a valorar están datos de alta y verificación, contactos, administradores, historial de cambios, cuentas relacionadas, accesos, IP, dispositivos, perfil y método de pagos, beneficiario, transacciones e importes. Debe pedirse solo lo necesario y proporcional, condicionado a que el proveedor lo conserve y pueda legalmente facilitarlo.

## Errores que deben evitarse

- confundir un píxel de medición con una cuenta receptora de pagos;
- atribuir al titular de un `RESELLER` la propiedad de la web;
- ignorar que un código puede ser antiguo, compartido o cargado por un tercero;
- omitir fecha, hora o procedencia del hallazgo;
- considerar el hash como una firma o sello de tiempo;
- enviar el texto generado sin revisión jurídica;
- introducir datos sensibles en issues públicos o servicios externos.

## Conclusión prudente

«Se ha observado el identificador X, asociado técnicamente al servicio Y, en la URL Z y en la fecha indicada. Constituye un pivote para solicitar al proveedor la identificación y demás datos que conserve, sujeto a habilitación legal».

La identidad de la persona y su beneficio económico se establecen con la respuesta oficial y la corroboración posterior, no con el código aislado.
