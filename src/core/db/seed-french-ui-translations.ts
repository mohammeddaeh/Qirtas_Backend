/**
 * Manual, hand-edited seed for the French ("fr") dynamic language — the
 * first real non-bundled language added to the app, per
 * docs/reference/dynamic_localization.md §5 (Model 2: ar/en stay
 * compile-time; any additional language is served entirely from
 * `languages`/`translation_entries`).
 *
 * This is the "edit this file directly, then re-run" workflow for adding or
 * updating French UI text from the backend side, without touching the
 * frontend or going through curl/Postman by hand each time. To edit an
 * existing translation or add a new key: change/add an entry in
 * `FRENCH_UI_TRANSLATIONS` below, then re-run:
 *   npm run db:seed -- --fr
 * Safe to re-run any number of times — upserts by (language_code, key) via
 * `translation-entries.repository.ts` `upsertMany`, existing values are
 * simply overwritten, no duplicates, and the language's `version` is bumped
 * each run so the app picks up the change (see `GET /:code/translations`).
 *
 * Key naming: these keys MUST match the exact `LocaleKeys.x` names used in
 * the Flutter app's `assets/translations/ar.json`/`en.json` (e.g. `login`,
 * `welcomeBack`) — NOT the `permission.<key>` convention used by the core
 * seed's permission display names (a separate, unrelated concern — see
 * `seed-core.ts`).
 *
 * Invoked by the orchestrator in `seed.ts`; this module never opens or closes
 * the pool.
 */
import { ensureLanguageExists } from './seed-shared.js';
import * as languagesRepository from '../../features/localization/repositories/languages.repository.js';
import * as translationEntriesRepository from '../../features/localization/repositories/translation-entries.repository.js';
import { logger } from '../logger/logger.js';

const LANGUAGE_CODE = 'fr';
const LANGUAGE_NAME = 'Français';
const LANGUAGE_IS_RTL = false;

/**
 * Add/edit French translations here. Key = the same `LocaleKeys.x` name used
 * in the Flutter app. Value = the French text. Not exhaustive by design —
 * add more keys over time as needed; any key not listed here simply isn't
 * translated to French yet (the app falls back to showing the raw key in
 * that case — see docs/reference/dynamic_localization.md §4 Scenarios).
 */
const FRENCH_UI_TRANSLATIONS: Record<string, string> = {
  welcomeBack: 'Bon retour',
  loginToYourAccount: 'Connectez-vous à votre compte',
  login: 'Connexion',
  eMail: 'E-mail',
  password: 'Mot de passe',
  forgotPassword: 'Mot de passe oublié ?',
  dontHaveAccount: "Vous n'avez pas de compte ?",
  SignUp: "S'inscrire",

  homeSubtitle: 'Tableau de bord',
  quickAccess: 'Accès rapide',
  manageUsers: 'Gérer les utilisateurs',
  manageUsersSubtitle: 'Ajouter, modifier, désactiver des comptes',
  manageRoles: 'Gérer les rôles',
  manageRolesSubtitle: 'Rôles et permissions',
  manageBranches: 'Gérer les succursales',
  manageBranchesSubtitle: 'Emplacements et paramètres',
  registrationReview: 'Revue des inscriptions',
  registrationReviewSubtitle: 'Approuver ou rejeter les demandes',
  homeEmptyTitle: 'Rien à afficher',
  homeEmptyDescription: "Vous n'avez accès à aucune section pour le moment",

  settings: 'Paramètres',
  profile: 'Profil',
  logOut: 'Déconnexion',
  language: 'Langue',
  theme: 'Thème',
  themeLight: 'Clair',
  themeDark: 'Sombre',
  themeSystem: 'Système',

  users: 'Utilisateurs',
  roles: 'Rôles',
  branches: 'Succursales',
  permissions: 'Permissions',
  addUser: 'Ajouter un utilisateur',
  editUser: "Modifier l'utilisateur",
  addRole: 'Ajouter un rôle',
  addBranch: 'Ajouter une succursale',
  editBranch: 'Modifier la succursale',
  save: 'Enregistrer',
  cancel: 'Annuler',
  confirm: 'Confirmer',
  delete: 'Supprimer',
  edit: 'Modifier',
  active: 'Actif',
  inactive: 'Inactif',

  suspendUser: "Suspendre l'utilisateur",
  disableUser: "Désactiver l'utilisateur",
  reactivateUser: "Réactiver l'utilisateur",
  approve: 'Approuver',
  reject: 'Rejeter',

  fieldRequired: 'Ce champ est requis',
  invalidEmailAddress: 'Adresse e-mail invalide',
  success: 'Succès',
  error: 'Erreur',
  warning: 'Avertissement',
  loading: 'Chargement…',
};

export async function seedFrenchUiTranslations(): Promise<void> {
  await ensureLanguageExists(LANGUAGE_CODE, LANGUAGE_NAME, LANGUAGE_IS_RTL, 'French UI');

  await translationEntriesRepository.upsertMany(LANGUAGE_CODE, FRENCH_UI_TRANSLATIONS);
  await languagesRepository.incrementVersion(LANGUAGE_CODE);

  logger.info(
    `Seeded ${Object.keys(FRENCH_UI_TRANSLATIONS).length} UI translation entries for "${LANGUAGE_CODE}"`,
  );
}
