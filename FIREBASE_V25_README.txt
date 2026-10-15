BONS DE COMMANDE — V20 CORRIGEE
SYNCHRONISATION FIREBASE / FIRESTORE

OBJECTIF
Cette application reste d'abord locale. Android et PC peuvent fonctionner normalement
sans Firebase. Firebase/Firestore sert uniquement à conserver une copie synchronisee
entre les appareils.

1. STOCKAGE LOCAL
- Les donnees fonctionnelles restent dans le stockage local du navigateur/application.
- Le dossier de stockage choisi par l'utilisateur continue a recevoir le fichier
  bon-de-commande-data.json.
- Une panne Internet ou Firebase ne supprime pas les donnees locales et ne bloque pas
  la saisie, la modification, l'historique ou la generation des PDF.

2. PDF
- Les PDF des bons sont generes localement avec jsPDF.
- Aucun PDF n'est envoye vers Firebase.
- Aucun code de televersement de PDF vers Firebase Storage n'est utilise.
- Les PDF restent donc hors du quota de stockage Firestore.

3. IMAGES
- Les logos/cachets sont conserves dans les donnees locales et, lorsqu'ils font partie
  d'une fiche synchronisee, peuvent etre synchronises dans Firestore.
- Avec moins d'une dizaine d'images de petite taille, cela reste tres faible.
- Une future migration vers Firebase Storage n'est pas necessaire pour l'usage actuel.

4. SYNCHRONISATION V3
- Chaque type de donnee possede sa sous-collection Firestore.
- Chaque modification locale recoit _syncUpdatedAt et _syncDeviceId.
- Une file locale persistante protege les modifications qui attendent leur envoi.
- Une modification distante plus ancienne ne peut pas ecraser une modification locale
  plus recente.
- Les suppressions sont synchronisees avec des tombstones (_deleted=true).
- Les lots d'ecriture sont limites a 450 documents par batch.
- Les lectures inutiles ont ete reduites : la synchronisation utilise directement le
  snapshot initial de chaque listener pour detecter les donnees locales absentes du cloud,
  au lieu de faire un .get() supplementaire pour chaque collection.
- Les anciennes donnees V19 stockees dans workspaces/{code}.data sont migrees vers les
  sous-collections lors de la premiere connexion.

5. RESOLUTION DES CONFLITS
La resolution est deterministe :
- la version logique _syncUpdatedAt la plus recente gagne ;
- en cas d'egalite, _syncDeviceId determine l'ordre ;
- une modification locale encore en attente d'envoi reste prioritaire jusqu'a sa prise
  en compte par le cloud.

6. FIREBASE
A activer dans la console Firebase :
- Authentication > Anonymous
- Cloud Firestore > Database
- publier firestore.rules

Utiliser exactement la meme configuration Firebase et le meme code d'espace sur Android
et PC.

IMPORTANT SECURITE
Le code d'espace n'est pas un mot de passe cryptographique. Les regles fournies
autorisent les utilisateurs Firebase authentifies a acceder aux workspaces. Cette
configuration est adaptee a l'objectif actuel d'un seul utilisateur, mais elle ne doit
pas etre presentee comme une securite forte pour une application publique ou multi-client.

7. QUOTAS FIRESTORE STANDARD — NIVEAU SANS FRAIS
Les quotas actuels de Cloud Firestore Standard sont :
- 1 Gio de donnees stockees
- 50 000 lectures de documents par jour
- 20 000 ecritures de documents par jour
- 20 000 suppressions de documents par jour
- 10 Gio de transfert sortant par mois

Les quotas sont remis a zero quotidiennement. Le stockage est mesure en Gio et inclut
les index et la surcharge de stockage.

Pour cette application personnelle (1 utilisateur, Android + PC), ces limites sont
largement superieures a un usage normal. Les PDF ne sont pas envoyes vers Firestore.

8. CONSEIL D'UTILISATION
Ne pas supprimer ou modifier manuellement les documents Firestore. L'application doit
etre la seule a gerer les donnees de synchronisation.
