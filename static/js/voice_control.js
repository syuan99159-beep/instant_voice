(function () {
  const buttonId = 'voiceControlButton';
  const statusId = 'voiceControlStatus';

  let mediaRecorder = null;
  let chunks = [];
  let stream = null; // only present during active recording
  let stopTimeoutId = null;

  function setStatus(text) {
    const el = document.getElementById(statusId);
    if (el) el.textContent = text;
  }

  function tryCallFunctionOrClick(name, selector) {
    try {
      if (typeof window[name] === 'function') {
        window[name]();
        return true;
      }
    } catch (e) {
      // ignore
    }

    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      return true;
    }

    return false;
  }

  function isLoopEnabled() {
    const loopBtn = document.querySelector('[data-action="toggle-loop"]');
    if (!loopBtn) return false;
    return (loopBtn.textContent || '').includes('開');
  }

  function setLoopState(enabled) {
    const current = isLoopEnabled();
    if (current === enabled) return true;
    return tryCallFunctionOrClick('toggleLoop', '[data-action="toggle-loop"]');
  }

  const existingExecuteVoiceCommand = typeof window.executeVoiceCommand === 'function'
    ? window.executeVoiceCommand
    : null;

  function executeVoiceCommand(command) {
    if (existingExecuteVoiceCommand) {
      try {
        existingExecuteVoiceCommand(command);
        return;
      } catch (e) {
        console.warn('existing executeVoiceCommand failed, fallback to local handler', e);
      }
    }

    // Use existing player functions/buttons without changing app.js core logic.
    switch (command) {
      case 'play':
        tryCallFunctionOrClick('playCurrent', '[data-action="toggle-play"]') || tryCallFunctionOrClick('playAudio', '[data-action="toggle-play"]') || tryCallFunctionOrClick('togglePlay', '[data-action="toggle-play"]');
        break;
      case 'pause': {
        const handled = tryCallFunctionOrClick('pauseAudio', '[data-action="toggle-play"]');
        if (!handled) {
          const audioEl = document.getElementById('audioPlayer');
          if (audioEl && typeof audioEl.pause === 'function') {
            audioEl.pause();
          }
        }
        break;
      }
      case 'next':
        tryCallFunctionOrClick('nextSentence', '[data-action="next"]') || tryCallFunctionOrClick('jumpToNextSentence', '[data-action="next"]');
        break;
      case 'previous':
      case 'prev':
        tryCallFunctionOrClick('prevSentence', '[data-action="previous"]') || tryCallFunctionOrClick('jumpToPreviousSentence', '[data-action="previous"]');
        break;
      case 'restart':
        tryCallFunctionOrClick('restartAudio', '[data-action="restart"]') || tryCallFunctionOrClick('restartPlayback', '[data-action="restart"]');
        break;
      case 'loop_on':
        setLoopState(true);
        break;
      case 'loop_off':
        setLoopState(false);
        break;
      default:
        console.warn('Unknown voice command:', command);
        break;
    }
  }

  if (!existingExecuteVoiceCommand) {
    window.executeVoiceCommand = executeVoiceCommand;
  }

  function handleCommand(command) {
    executeVoiceCommand(command);
  }

  async function sendBlob(blob) {
    const form = new FormData();
    form.append('file', blob, 'voice.webm');

    setStatus('上傳中...');

    try {
      const resp = await fetch('/api/voice-command', {
        method: 'POST',
        body: form,
      });

      if (!resp.ok) {
        setStatus('伺服器回應錯誤');
        console.error('Server returned', resp.status);
        return;
      }

      const data = await resp.json();
      console.log(data);
      setStatus(data.text ? `已辨識：${data.text}` : '已辨識');

      if (data.command && data.command !== 'unknown') {
        executeVoiceCommand(data.command);
      }
    } catch (err) {
      console.error(err);
      setStatus('上傳失敗');
    }
  }

  function stopRecordingAndUpload() {
    if (!mediaRecorder) return;
    try {
      mediaRecorder.stop();
    } catch (e) {
      // ignore
    }
  }

  function startRecording() {
    // Ensure we only start recording when invoked (stream created on demand)
    chunks = [];

    try {
      mediaRecorder = new MediaRecorder(stream);
    } catch (err) {
      console.error('MediaRecorder not supported or failed:', err);
      setStatus('不支援錄音');
      cleanupStream();
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      sendBlob(blob);
      // stop and release media tracks
      cleanupStream();
    };

    mediaRecorder.start();
    // 5 秒自動停止以避免過長錄音
    stopTimeoutId = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecordingAndUpload();
      }
    }, 5000);

    setStatus('正在聆聽...');
  }

  function cleanupStream() {
    try {
      if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
      }
      if (stream) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch (e) {}
        });
      }
    } finally {
      stream = null;
      mediaRecorder = null;
    }
  }

  function ensureStream() {
    if (stream) return Promise.resolve(stream);
    // Acquire microphone only when starting a recording. Use common constraints to reduce speaker pickup.
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((s) => {
        stream = s;
        return stream;
      })
      .catch((err) => {
        console.error('getUserMedia failed', err);
        setStatus('無法取得麥克風權限');
        throw err;
      });
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById(buttonId);
    if (!btn) return;

    // 觸發取得權限但不開始錄音
    btn.addEventListener('mousedown', async (ev) => {
      ev.preventDefault();
      try {
        // 如果播放器正在播放，拒絕錄音以避免誤辨識
        const audioEl = document.getElementById('audioPlayer');
        if (audioEl && !audioEl.paused && !audioEl.ended) {
          setStatus('請先暫停播放以使用語音控制');
          return;
        }

        await ensureStream();
        startRecording();
        btn.classList.add('is-recording');
        btn.setAttribute('aria-pressed', 'true');
      } catch (e) {
        // permission error 已處理
      }
    });

    // for touch devices
    btn.addEventListener('touchstart', async (ev) => {
      ev.preventDefault();
      try {
        const audioEl = document.getElementById('audioPlayer');
        if (audioEl && !audioEl.paused && !audioEl.ended) {
          setStatus('請先暫停播放以使用語音控制');
          return;
        }

        await ensureStream();
        startRecording();
        btn.classList.add('is-recording');
        btn.setAttribute('aria-pressed', 'true');
      } catch (e) {}
    }, { passive: false });

    const finish = (ev) => {
      if (!btn.classList.contains('is-recording')) return;

      // Only block default touch behavior while actively recording.
      if (ev.type.startsWith('touch')) {
        ev.preventDefault();
      }

      btn.classList.remove('is-recording');
      btn.setAttribute('aria-pressed', 'false');
      stopRecordingAndUpload();
    };

    document.addEventListener('mouseup', finish);
    document.addEventListener('touchend', finish, { passive: false });
    document.addEventListener('touchcancel', finish, { passive: false });

    // 按住時也可按 Esc 中斷
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (btn.classList.contains('is-recording')) {
          btn.classList.remove('is-recording');
          btn.setAttribute('aria-pressed', 'false');
          stopRecordingAndUpload();
        }
      }
    });

    // 初始化狀態文字
    setStatus('按住說話開始錄音');
  });
})();
