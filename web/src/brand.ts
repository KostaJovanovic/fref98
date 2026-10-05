// The product's names in one place.
export const APP_NAME = 'File Refragmenter 98 Gold';
/** Project files (a ZIP of photos + steps). Old .jpegit files and plain .zip still open. */
export const PROJECT_EXT = '.rfg';
export const OLD_PROJECT_EXT = '.jpegit';
/** Every extension stripped from a project's file name when it is opened. */
export const PROJECT_NAME_EXT = new RegExp(`(\\${PROJECT_EXT}|\\${OLD_PROJECT_EXT}|\\.zip)$`, 'i');
