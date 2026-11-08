export const STRINGS = {
  en: {
    title: 'Pose prototype',
    undo: 'Undo', redo: 'Redo', reset: 'Reset', view: 'View', pins: 'Dots', skirt: 'Skirt', snap: 'Snapshot', lens: 'Lens', timer: 'Timer',
    hint1: 'Drag a dot to pose. The body follows.',
    hint2: 'Tap a dot to pin or unpin it. Red = pinned.',
    hint3: 'Drag a body part to rotate that joint. Drag empty space to orbit, pinch to zoom.',
    gotIt: 'Got it',
    saveHint: 'Long-press or right-click the image to save it.',
    close: 'Close',
    views: ['3/4', 'Front', 'Side', 'Back'],
  },
  es: {
    title: 'Prototipo de poses',
    undo: 'Deshacer', redo: 'Rehacer', reset: 'Reiniciar', view: 'Vista', pins: 'Puntos', skirt: 'Falda', snap: 'Captura', lens: 'Lente', timer: 'Tiempo',
    hint1: 'Arrastra un punto para posar. El cuerpo lo sigue.',
    hint2: 'Toca un punto para fijarlo o soltarlo. Rojo = fijo.',
    hint3: 'Arrastra una parte del cuerpo para rotar esa articulación. Arrastra el fondo para girar la cámara y pellizca para hacer zoom.',
    gotIt: 'Entendido',
    saveHint: 'Mantén pulsada la imagen o haz clic derecho para guardarla.',
    close: 'Cerrar',
    views: ['3/4', 'Frente', 'Lado', 'Espalda'],
  },
  pt: {
    title: 'Protótipo de poses',
    undo: 'Desfazer', redo: 'Refazer', reset: 'Redefinir', view: 'Vista', pins: 'Pontos', skirt: 'Saia', snap: 'Captura', lens: 'Lente', timer: 'Tempo',
    hint1: 'Arraste um ponto para posar. O corpo acompanha.',
    hint2: 'Toque em um ponto para fixar ou soltar. Vermelho = fixo.',
    hint3: 'Arraste uma parte do corpo para girar essa articulação. Arraste o fundo para girar a câmera e use pinça para zoom.',
    gotIt: 'Entendi',
    saveHint: 'Toque e segure a imagem ou clique com o botão direito para salvar.',
    close: 'Fechar',
    views: ['3/4', 'Frente', 'Lado', 'Costas'],
  },
  ko: {
    title: '포즈 프로토타입',
    undo: '실행 취소', redo: '다시 실행', reset: '초기화', view: '시점', pins: '점 표시', skirt: '치마', snap: '캡처', lens: '렌즈', timer: '타이머',
    hint1: '점을 끌면 포즈가 잡히고 몸이 따라와요.',
    hint2: '점을 탭하면 고정되거나 풀려요. 빨간색이 고정이에요.',
    hint3: '몸을 끌면 그 관절이 돌아가요. 빈 곳을 끌면 카메라가 돌고, 두 손가락으로 확대해요.',
    gotIt: '알겠어요',
    saveHint: '이미지를 길게 누르거나 우클릭해서 저장하세요.',
    close: '닫기',
    views: ['3/4', '정면', '측면', '뒤'],
  },
};

export function detectLang() {
  try {
    const saved = localStorage.getItem('pose.lang');
    if (saved && STRINGS[saved]) return saved;
  } catch { /* storage may be unavailable */ }
  const nav = (navigator.language || 'en').slice(0, 2);
  return STRINGS[nav] ? nav : 'en';
}
