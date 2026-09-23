# Seguridad

El alcance soportado es una PoC local de un único operador, con interfaz enlazada a loopback. No exponer directamente a Internet ni a una red compartida. El modo de servicio existente requiere evaluación adicional antes de usarse como plataforma multiusuario; ver [decisiones pendientes](docs/security/deferred-decisions.md).

Las credenciales se configuran mediante el entorno o la interfaz local. El archivo .env.local, los documentos de knowledge_base/ y los proyectos locales contienen información privada y no forman parte de la distribución. Usar fuentes aprobadas para RAG. Los proveedores externos reciben el contexto seleccionado para cada análisis; verificar su autorización interna antes de habilitarlos.

Las mutaciones locales requieren mismo origen y loopback. En modo PostgreSQL, los tokens de análisis no permiten modificar credenciales ni el corpus global. Estas restricciones no sustituyen SSO, autorización por recurso ni aislamiento multiusuario.

No incluir secretos ni documentos privados al reportar vulnerabilidades en issues abiertos. Ante una exposición, revocar la credencial afectada y seguir el proceso de respuesta a incidentes de la organización que controla los datos.

La integración continua ejecuta pruebas, auditoría de dependencias y un escaneo de secretos independiente. Una auditoría sin hallazgos no certifica la seguridad del producto.
