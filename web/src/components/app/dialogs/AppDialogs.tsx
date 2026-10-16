import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import LyricMatchModal from '../../modal/LyricMatchModal';
import NaviLyricMatchModal from '../../modal/NaviLyricMatchModal';
import OnlineLyricMatchModal from '../../modal/OnlineLyricMatchModal';
import UnavailableReplacementDialog from '../../modal/UnavailableReplacementDialog';
import SettingsModal from '../../modal/SettingsModal';
import ConfirmDialog from '../../shared/ConfirmDialog';
import type { AppDialogsModel } from './buildAppDialogsModel';
import { countRender } from '../../../dev/renderCount';
import StatusToast from './StatusToast';

// Centralized app-level dialog and toast renderer for the player shell.
type AppDialogsProps = {
    model: AppDialogsModel;
};

const AppDialogs: React.FC<AppDialogsProps> = ({ model }) => {
    countRender('AppDialogs');
    const { statusToast, lyricMatchDialog, naviLyricMatchDialog, onlineLyricMatchDialog, unavailableReplacementDialog, settingsDialog, wallpaperEntryConfirmDialog } = model;

    return (
        <>
            {createPortal(
                <AnimatePresence>
                    {statusToast && (
                        <StatusToast key={statusToast.toastKey} statusToast={statusToast} />
                    )}
                </AnimatePresence>,
                document.body,
            )}

            {lyricMatchDialog && <LyricMatchModal {...lyricMatchDialog} />}
            {naviLyricMatchDialog && <NaviLyricMatchModal {...naviLyricMatchDialog} />}
            {onlineLyricMatchDialog && <OnlineLyricMatchModal {...onlineLyricMatchDialog} />}
            {unavailableReplacementDialog && <UnavailableReplacementDialog {...unavailableReplacementDialog} />}
            {wallpaperEntryConfirmDialog && <ConfirmDialog {...wallpaperEntryConfirmDialog} />}
            <AnimatePresence>
                {settingsDialog && <SettingsModal {...settingsDialog} />}
            </AnimatePresence>
        </>
    );
};

export default React.memo(AppDialogs);
