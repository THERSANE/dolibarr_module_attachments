<?php
/* Copyright (C) 2026 THERSANE
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * \file    ajax/attachments.php
 * \ingroup attachments
 * \brief   Ajax interface of the e-mail attachments picker
 *
 * GET  mode=list   element, id, trackid                    => files that can be attached, grouped
 * POST mode=apply  element, id, trackid, files[] (md5)     => attach / detach, returns the new attached files HTML
 * POST mode=remove element, id, trackid, key, name          => remove one attached file (native trash button), returns the new attached files HTML
 */

if (!defined('NOTOKENRENEWAL')) define('NOTOKENRENEWAL', '1'); // The token of the e-mail form must stay valid
if (!defined('NOREQUIREMENU')) define('NOREQUIREMENU', '1');
if (!defined('NOREQUIREHTML')) define('NOREQUIREHTML', '1');
if (!defined('NOREQUIREAJAX')) define('NOREQUIREAJAX', '1');
if (!defined('NOBROWSERNOTIF')) define('NOBROWSERNOTIF', '1');

$res = 0;
if (!$res && !empty($_SERVER["CONTEXT_DOCUMENT_ROOT"])) $res = @include $_SERVER["CONTEXT_DOCUMENT_ROOT"]."/main.inc.php";
$tmp = empty($_SERVER['SCRIPT_FILENAME']) ? '' : $_SERVER['SCRIPT_FILENAME']; $tmp2 = realpath(__FILE__); $i = strlen($tmp) - 1; $j = strlen($tmp2) - 1;
while ($i > 0 && $j > 0 && isset($tmp[$i]) && isset($tmp2[$j]) && $tmp[$i] == $tmp2[$j]) {
	$i--;
	$j--;
}
if (!$res && $i > 0 && file_exists(substr($tmp, 0, ($i + 1))."/main.inc.php")) $res = @include substr($tmp, 0, ($i + 1))."/main.inc.php";
if (!$res && $i > 0 && file_exists(dirname(substr($tmp, 0, ($i + 1)))."/main.inc.php")) $res = @include dirname(substr($tmp, 0, ($i + 1)))."/main.inc.php";
if (!$res && file_exists("../../main.inc.php")) $res = @include "../../main.inc.php";
if (!$res && file_exists("../../../main.inc.php")) $res = @include "../../../main.inc.php";
if (!$res) die("Include of main fails");

/**
 * @var Conf $conf
 * @var DoliDB $db
 * @var HookManager $hookmanager
 * @var Translate $langs
 * @var User $user
 */

require_once DOL_DOCUMENT_ROOT.'/core/lib/files.lib.php';
dol_include_once('attachments/class/actions_attachments.class.php');
dol_include_once('attachments/lib/attachments.lib.php');

$langs->loadLangs(array('main', 'errors', 'attachments@attachments'));

$mode = GETPOST('mode', 'aZ09');
$elementType = GETPOST('element', 'aZ09arobase');
$id = GETPOSTINT('id');
$trackid = GETPOST('trackid', 'aZ09');

/**
 * Print a JSON answer and stop
 *
 * @param   array   $data       Data
 * @param   int     $httpCode   HTTP code
 * @return  void
 */
function attachmentsAjaxAnswer($data, $httpCode = 200)
{
	http_response_code($httpCode);
	print json_encode($data);
	exit;
}

top_httphead('application/json');

if (!isModEnabled('attachments')) {
	attachmentsAjaxAnswer(array('success' => false, 'message' => 'Module disabled'), 403);
}
if (!in_array($mode, array('list', 'apply', 'remove')) || empty($elementType) || $id <= 0 || empty($trackid)) {
	attachmentsAjaxAnswer(array('success' => false, 'message' => $langs->transnoentities('ErrorBadParameters')), 400);
}
if ($mode !== 'list' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
	attachmentsAjaxAnswer(array('success' => false, 'message' => $langs->transnoentities('ErrorBadParameters')), 405);
}

// Load the object and check the user can read it (same check as core/ajax/ajaxtooltip.php)
$object = fetchObjectByElement($id, $elementType);
if (!is_object($object) || empty($object->element) || empty($object->id)) {
	attachmentsAjaxAnswer(array('success' => false, 'message' => $langs->transnoentities('ErrorRecordNotFound')), 404);
}
$module = $object->module;
$element = $object->element;
$usesublevelpermission = ($module != $element ? $element : '');
if ($usesublevelpermission && !$user->hasRight($module, $element)) {
	$usesublevelpermission = '';
}
restrictedArea($user, $object->module, $object, $object->table_element, $usesublevelpermission);

if (method_exists($object, 'fetch_thirdparty') && empty($object->thirdparty)) {
	$object->fetch_thirdparty();
}

$withDelete = !GETPOSTINT('readonly');
$entity = !empty($object->entity) ? (int) $object->entity : (int) $conf->entity;

if ($mode === 'remove') {
	// Same as the core trash button (core/actions_sendmails.inc.php, removedfile) without the page reload:
	// the file is only removed from the list of the e-mail, never deleted (it may be the official PDF of the document)
	include_once DOL_DOCUMENT_ROOT.'/core/class/html.formmail.class.php';
	$formmail = new FormMail($db);
	$formmail->trackid = $trackid;
	$TAttachedFile = $formmail->get_attached_files();

	$key = GETPOSTINT('key');
	$name = GETPOST('name', 'none'); // Only compared to the session list, never printed
	if ($key < 0 || !isset($TAttachedFile['names'][$key]) || $TAttachedFile['names'][$key] !== $name) {
		// The list changed in the meantime (other tab...): give back the real list, nothing removed
		attachmentsAjaxAnswer(array(
			'success' => false,
			'message' => $langs->transnoentities('AttachmentsRemoveOutdated'),
			'attachedHtml' => attachmentsGetAttachedFilesHtml($trackid, $withDelete, $entity),
		), 409);
	}

	$formmail->remove_attached_files($key);

	attachmentsAjaxAnswer(array(
		'success' => true,
		'removed' => 1,
		'attachedHtml' => attachmentsGetAttachedFilesHtml($trackid, $withDelete, $entity),
	));
}

$hookmanager->initHooks(array('attachmentsform'));
$actionattachments = new ActionsAttachments($db);
$action = 'presend';
$actionattachments->collectFiles($object, $action, $hookmanager);

if ($mode === 'list') {
	attachmentsAjaxAnswer(array(
		'success' => true,
		'groups' => $actionattachments->getFileGroups($trackid),
	));
}

// mode=apply
$TAttachments = array();
foreach (GETPOST('files', 'array') as $md5) {
	if (is_string($md5) && preg_match('/^[a-f0-9]{32}$/', $md5)) {
		$TAttachments[$md5] = $md5;
	}
}

$result = $actionattachments->applySelection($TAttachments, $trackid);
$TAttached = (new FormMail($db));
$TAttached->trackid = $trackid;
$TAttachedFile = $TAttached->get_attached_files();

attachmentsAjaxAnswer(array(
	'success' => true,
	'added' => $result['added'],
	'removed' => $result['removed'],
	'failed' => $result['failed'],
	'failedMessage' => $result['failed'] > 0 ? $langs->transnoentities('AttachmentsNbFailed', $result['failed']) : '',
	'attachedCount' => count(array_filter($TAttachedFile['names'], 'strlen')),
	'attachedHtml' => attachmentsGetAttachedFilesHtml($trackid, $withDelete, $entity),
));
