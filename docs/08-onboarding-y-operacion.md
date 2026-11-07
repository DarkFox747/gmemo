# 08 · Onboarding proyecto↔repo y operación

## Provisión centralizada por ticket
El owner del módulo es un **sysadmin** de la empresa. Alta de personas, repos, permisos y proyectos → **ticket
en un sistema interno**. El Project Admin NO auto-provisiona; queda como curador. Pendiente: ¿el sistema de
tickets ejecuta el cambio por una API de administración, o el sysadmin ejecuta a mano tras aprobar? (mi voto: manual,
el ticket como gate de proceso + auditoría).

## Recorrido de alta
Platform Owner/Admin crea el proyecto (seed manual del primer Platform Owner — problema del huevo/gallina) →
registra el/los repos → provee miembros → primera build del grafo → listo.

Decisiones:
- **Verificación de propiedad del repo:** por ahora sin GitHub App; el **sysadmin verifica** como parte del ticket.
  (La App quedaba como opción para automatizarlo; se pospuso — "por ahora sigamos con la pipeline/Actions".)
- **Integración:** GitHub **Actions + OIDC + webhooks** (no GitHub App por ahora). Los tres eventos (PR abierto /
  mergeado / rama borrada) se cablean por workflow.
- **Provisión de usuarios (JIT):** en el primer login exitoso se crea el `app_user` sin membresías (Compuerta A ya
  garantizó el dominio); el acceso se otorga por ticket (Compuerta B).
- **Rama de promoción:** configurable, **SIN default**, se pregunta en el alta.
- **Credencial de máquina:** la emite un **Platform Admin** (scoped al proyecto, revocable).
- **Offboarding:** el acceso se corta ya; la memoria queda (con su author_identity) salvo borrado por botón de pánico.

## Build del grafo (Layer 2) — corre en la CI del repo
Decisión: sacar el cómputo del grafo de nuestra infra; lo corre la **CI del repo** (sus runners) y nos envía el
resultado.
- Trigger: merge a la **rama principal del repo** (el grafo refleja mainline; puede diferir de la rama de promoción
  de la memoria).
- La CI corre el indexado (cbm) → produce el artefacto.
- **No lo POSTea** (puede ser grande): nuestro backend le da una **URL prefirmada de S3**, la CI sube directo a S3,
  y después **notifica** un endpoint (repo, sha, key). El backend registra + carga en el servicio de grafo.
- Auth: OIDC; el rol solo puede pedir la URL prefirmada y notificar **para su propio repo** (valida el claim).
  Dato derivado, baja confianza → alcanza con validar procedencia + checksum.
- Pendiente: confirmar subida por URL prefirmada (recomendado) y si proveemos el **template de workflow** con la
  versión correcta de cbm.

## Piloto vs producción
Piloto (Fase 0): EC2 + Express + Cognito + RDS chico, 1-2 equipos, para validar adopción. NO meter los atajos del
piloto en prod. Producción: la topología administrada (ver 02).
