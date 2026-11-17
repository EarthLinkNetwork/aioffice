#!/usr/bin/env node
// 合言葉を忘れた時の戻し方: docker exec aioffice aioffice-reset-owner
// 持ち主の登録を消し、前の cookie を全部無効にする。会社・担当・AI の契約のつなぎは残る。次にブラウザで開くと合言葉を決め直す画面が出る
import { openStore } from '../launcher/lib/state.mjs';

const dir = `${process.env.AIOFFICE_DATA_ROOT || '/data'}/aioffice`;
openStore(dir).resetOwner();
console.log('The owner password was removed. Open the office in your browser and choose a new password.');
console.log('持ち主の合言葉を消しました。ブラウザでオフィスを開き、新しい合言葉を決めてください。');
