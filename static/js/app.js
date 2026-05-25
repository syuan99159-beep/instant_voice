(() => {
  const FONT_SIZE_MAP = {
    small: 15,
    medium: 20,
    large: 28,
  };

  const SPEED_OPTIONS = [2, 1.5, 1, 0.75, 0.5];

  const formatTime = (value) => {
    const seconds = Number.isFinite(value) && value > 0 ? value : 0;
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  };

  class SubtitleTimeline {
    constructor(rawItems = []) {
      this.rawItems = Array.isArray(rawItems) ? rawItems : [];
      this.segments = this.normalizeSegments(this.rawItems);
      this.charSegments = this.buildCharacterSegments(this.segments);
    }

    normalizeSegments(rawItems) {
      return rawItems
        .map((item, index) => {
          const start = Number(item?.start ?? 0);
          const end = Number(item?.end ?? start);
          const text = typeof item?.text === 'string' ? item.text : '';
          const mode = item?.mode === 'manual' ? 'manual' : 'auto';
          const chars = Array.isArray(item?.chars) ? item.chars : null;
          const normalizedChars = this.normalizeChars(chars);
          const char = typeof item?.char === 'string' ? item.char : '';
          const displayText = char || text;
          return {
            id: item?.id ?? index,
            index,
            start: Number.isFinite(start) ? start : 0,
            end: Number.isFinite(end) ? end : start,
            text,
            char,
            mode,
            chars: normalizedChars,
            displayText,
            kind: char ? 'char' : 'sentence',
          };
        })
        .filter((item) => item.displayText.length > 0)
        .sort((left, right) => left.start - right.start || left.index - right.index);
    }

    normalizeChars(chars) {
      if (!Array.isArray(chars)) {
        return null;
      }

      const normalized = chars
        .map((item, index) => {
          const start = Number(item?.start ?? 0);
          const end = Number(item?.end ?? start);
          const char = typeof item?.char === 'string' ? item.char : typeof item?.text === 'string' ? item.text : '';

          return {
            id: item?.id ?? index,
            index,
            char,
            start: Number.isFinite(start) ? start : 0,
            end: Number.isFinite(end) ? end : start,
          };
        })
        .filter((item) => item.char.length > 0)
        .sort((left, right) => left.start - right.start || left.index - right.index);

      return normalized.length > 0 ? normalized : null;
    }

    buildCharacterSegments(segments) {
      const expanded = [];

      segments.forEach((segment, segmentIndex) => {
        const manualChars = segment.mode === 'manual' && segment.chars && segment.chars.length ? segment.chars : null;

        if (manualChars) {
          manualChars.forEach((charItem, charIndex) => {
            expanded.push({
              segmentIndex,
              sourceIndex: segment.index,
              charIndex,
              text: charItem.char,
              start: charItem.start,
              end: charItem.end,
              mode: 'manual',
            });
          });
          return;
        }

        const sourceCharacters = Array.from(segment.displayText);
        if (segment.kind === 'char' || sourceCharacters.length <= 1) {
          expanded.push({
            segmentIndex,
            sourceIndex: segment.index,
            charIndex: 0,
            text: segment.displayText,
            start: segment.start,
            end: segment.end,
            mode: 'auto',
          });
          return;
        }

        const duration = Math.max(segment.end - segment.start, 0);
        const step = sourceCharacters.length > 0 ? duration / sourceCharacters.length : 0;

        sourceCharacters.forEach((character, characterIndex) => {
          const characterStart = segment.start + step * characterIndex;
          const characterEnd = characterIndex === sourceCharacters.length - 1 ? segment.end : characterStart + step;
          expanded.push({
            segmentIndex,
            sourceIndex: segment.index,
            charIndex: characterIndex,
            text: character,
            start: characterStart,
            end: characterEnd,
            mode: 'auto',
          });
        });
      });

      return expanded;
    }

    getCurrentIndex(currentTime) {
      if (!this.charSegments.length) {
        return -1;
      }

      const time = Number(currentTime) || 0;
      let candidateIndex = -1;

      for (let index = 0; index < this.charSegments.length; index += 1) {
        const segment = this.charSegments[index];
        const isLast = index === this.charSegments.length - 1;
        const withinRange = time >= segment.start && (time < segment.end || (isLast && time <= segment.end + 0.02));
        if (withinRange) {
          return index;
        }
        if (time >= segment.start) {
          candidateIndex = index;
        }
      }

      return candidateIndex;
    }

    getSentenceCharacterRange(sentenceIndex) {
      let startIndex = -1;
      let endIndex = -1;

      this.charSegments.forEach((segment, index) => {
        if (segment.sourceIndex !== sentenceIndex) {
          return;
        }

        if (startIndex < 0) {
          startIndex = index;
        }
        endIndex = index;
      });

      if (startIndex < 0 || endIndex < 0) {
        return null;
      }

      return {
        startIndex,
        endIndex,
      };
    }

    getCurrentSentenceIndex(currentTime) {
      const charIndex = this.getCurrentIndex(currentTime);
      if (charIndex < 0) {
        return -1;
      }
      return this.charSegments[charIndex]?.sourceIndex ?? -1;
    }

    getSentenceIndexByTime(currentTime) {
      if (!this.segments.length) {
        return -1;
      }

      const time = Number(currentTime) || 0;
      let candidateIndex = -1;

      for (let index = 0; index < this.segments.length; index += 1) {
        const segment = this.segments[index];
        const isLast = index === this.segments.length - 1;
        const withinRange = time >= segment.start && (time < segment.end || (isLast && time <= segment.end + 0.02));
        if (withinRange) {
          return index;
        }
        if (time >= segment.start) {
          candidateIndex = index;
        }
      }

      return candidateIndex;
    }

    getPreviousStart(currentTime) {
      const index = this.getSentenceIndexByTime(currentTime);
      if (index <= 0) {
        return 0;
      }
      return this.segments[index - 1].start;
    }

    getNextStart(currentTime) {
      if (!this.segments.length) {
        return 0;
      }

      const index = this.getSentenceIndexByTime(currentTime);
      const nextIndex = index < 0 ? 0 : index + 1;
      if (nextIndex >= this.segments.length) {
        return this.segments[this.segments.length - 1].start;
      }
      return this.segments[nextIndex].start;
    }
  }

  class SubtitleRenderer {
    constructor(container) {
      this.container = container;
      this.timeline = new SubtitleTimeline();
      this.activeCharIndex = -1;
      this.activeSentenceIndex = -1;
      this.currentFontSize = 'medium';
    }

    setTimeline(rawItems) {
      this.timeline = new SubtitleTimeline(rawItems);
      this.activeCharIndex = -1;
      this.activeSentenceIndex = -1;
      this.render();
    }

    setFontSize(sizeKey) {
      this.currentFontSize = sizeKey;
      this.container.classList.remove('subtitle-size-small', 'subtitle-size-medium', 'subtitle-size-large');
      this.container.classList.add(`subtitle-size-${sizeKey}`);
    }

    render() {
      const sentences = this.timeline.segments;
      this.container.innerHTML = '';

      if (!sentences.length) {
        const placeholder = document.createElement('p');
        placeholder.className = 'subtitle-placeholder';
        placeholder.textContent = '尚未載入字幕';
        this.container.appendChild(placeholder);
        return;
      }

      sentences.forEach((sentence, sentenceIndex) => {
        const line = document.createElement('div');
        line.className = 'subtitle-line';
        line.dataset.sentenceIndex = String(sentenceIndex);

        const sentenceCharacters = sentence.mode === 'manual' && sentence.chars && sentence.chars.length
          ? sentence.chars.map((item) => item.char)
          : Array.from(sentence.displayText);

        sentenceCharacters.forEach((character, characterIndex) => {
          const span = document.createElement('span');
          span.className = 'subtitle-char';
          span.dataset.segmentIndex = String(sentenceIndex);
          span.dataset.charIndex = String(characterIndex);
          span.textContent = character;
          line.appendChild(span);
        });

        this.container.appendChild(line);
      });

      this.updateActiveState(-1, -1);
    }

    updateByTime(currentTime) {
      const charIndex = this.timeline.getCurrentIndex(currentTime);
      const sentenceIndex = this.timeline.getCurrentSentenceIndex(currentTime);
      this.updateActiveState(charIndex, sentenceIndex);
    }

    updateActiveState(charIndex, sentenceIndex) {
      this.activeCharIndex = charIndex;
      this.activeSentenceIndex = sentenceIndex;

      const chars = this.container.querySelectorAll('.subtitle-char');
      const lines = this.container.querySelectorAll('.subtitle-line');

      chars.forEach((characterNode) => {
        characterNode.classList.remove('is-active');
      });

      lines.forEach((lineNode) => {
        lineNode.classList.remove('is-active');
      });

      if (charIndex < 0) {
        return;
      }

      const activeChar = chars[charIndex];
      if (activeChar) {
        activeChar.classList.add('is-active');
      }

      if (sentenceIndex >= 0) {
        const activeSentence = lines[sentenceIndex];
        if (activeSentence) {
          activeSentence.classList.add('is-active');
        }
      }
    }
  }

  class SutraPlayerApp {
    constructor() {
      this.audio = document.getElementById('audioPlayer');
      this.sutraSelect = document.getElementById('sutraSelect');
      this.subtitleContainer = document.getElementById('subtitleContainer');
      this.playbackState = document.getElementById('playbackState');
      this.timeState = document.getElementById('timeState');
      this.playButton = document.querySelector('[data-action="toggle-play"]');
      this.loopButton = document.querySelector('[data-action="toggle-loop"]');
      this.subtitleRenderer = new SubtitleRenderer(this.subtitleContainer);
      this.sutras = [];
      this.currentSutra = null;
      this.loopEnabled = false;
      this.speed = 1;
      this.fontSize = 'medium';
      this.isReady = false;
    }

    async init() {
      this.bindEvents();
      this.setFontSize(this.fontSize);
      this.setPlaybackSpeed(this.speed);
      await this.loadSutras();
    }

    bindEvents() {
      if (this.sutraSelect) {
        this.sutraSelect.addEventListener('change', async (event) => {
          await this.loadSutra(event.target.value);
        });
      }

      // back button from player view to book selection
      const backBtn = document.getElementById('backToBooks');
      if (backBtn) {
        backBtn.addEventListener('click', () => {
          // stop playback and show selection
          try {
            this.audio.pause();
          } catch (e) {}
          this.showSelectionView();
        });
      }

      document.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', () => this.handleAction(button.dataset.action));
      });

      document.querySelectorAll('[data-font-size]').forEach((button) => {
        button.addEventListener('click', () => this.setFontSize(button.dataset.fontSize));
      });

      document.querySelectorAll('[data-speed]').forEach((button) => {
        button.addEventListener('click', () => this.setPlaybackSpeed(Number(button.dataset.speed)));
      });

      this.audio.addEventListener('timeupdate', () => this.syncUI());
      this.audio.addEventListener('loadedmetadata', () => this.syncUI());
      this.audio.addEventListener('seeked', () => this.syncUI());
      this.audio.addEventListener('play', () => this.syncUI());
      this.audio.addEventListener('pause', () => this.syncUI());
      this.audio.addEventListener('ratechange', () => this.syncUI());
      this.audio.addEventListener('error', () => {
        this.playbackState.textContent = '音訊載入失敗';
        this.playButton.textContent = '播放';
      });
      this.audio.addEventListener('ended', () => {
        if (!this.loopEnabled) {
          this.playbackState.textContent = '播放結束';
          this.playButton.textContent = '播放';
        }
      });
    }

    async loadSutras() {
      try {
        const response = await fetch('/api/sutras');
        if (!response.ok) {
          throw new Error('無法取得經書清單');
        }

        const payload = await response.json();
        this.sutras = Array.isArray(payload.sutras) ? payload.sutras : [];
        this.populateSutraSelect();
        this.populateBookList();
        // show book selection view by default
        this.showSelectionView();
      } catch (error) {
        this.renderErrorState(error.message || '載入失敗');
      }
    }

    populateSutraSelect() {
      this.sutraSelect.innerHTML = '';

      this.sutras.forEach((sutra) => {
        const option = document.createElement('option');
        option.value = sutra.id;
        option.textContent = sutra.title;
        this.sutraSelect.appendChild(option);
      });
    }

    populateBookList() {
      const container = document.getElementById('bookList');
      if (!container) return;
      container.innerHTML = '';

      this.sutras.forEach((sutra) => {
        const card = document.createElement('button');
        card.className = 'book-card';
        card.type = 'button';
        card.textContent = sutra.title;
        card.addEventListener('click', async () => {
          // load sutra and show player
          await this.loadSutra(sutra.id);
          this.showPlayerView();
        });
        container.appendChild(card);
      });
    }

    showSelectionView() {
      const sel = document.getElementById('bookSelectionView');
      const player = document.getElementById('playerView');
      if (player) player.style.display = 'none';
      if (sel) sel.style.display = '';
    }

    showPlayerView() {
      const sel = document.getElementById('bookSelectionView');
      const player = document.getElementById('playerView');
      if (sel) sel.style.display = 'none';
      if (player) player.style.display = '';
      // ensure UI updated
      this.syncUI();
    }

    async loadSutra(sutraId) {
      if (!sutraId) {
        return;
      }

      try {
        const response = await fetch(`/api/sutras/${encodeURIComponent(sutraId)}`);
        if (!response.ok) {
          throw new Error('經書內容載入失敗');
        }

        const payload = await response.json();
        this.currentSutra = payload.sutra;
        // update title in player view
        const titleEl = document.getElementById('sutraTitle');
        if (titleEl) titleEl.textContent = this.currentSutra.title || '';
        this.subtitleRenderer.setTimeline(payload.subtitles || []);
        this.subtitleRenderer.setFontSize(this.fontSize);
        this.audio.src = this.currentSutra.audio;
        this.audio.currentTime = 0;
        this.audio.playbackRate = this.speed;
        this.playbackState.textContent = '已載入';
        this.playButton.textContent = '播放';
        this.syncUI();
      } catch (error) {
        this.renderErrorState(error.message || '經書切換失敗');
      }
    }

    handleAction(action) {
      switch (action) {
        case 'toggle-play':
          this.togglePlay();
          break;
        case 'previous':
          this.jumpToPreviousSentence();
          break;
        case 'next':
          this.jumpToNextSentence();
          break;
        case 'restart':
          this.restartPlayback();
          break;
        case 'toggle-loop':
          this.toggleLoop();
          break;
        default:
          break;
      }
    }

    async togglePlay() {
      if (!this.audio.src) {
        return;
      }

      if (this.audio.paused) {
        try {
          await this.audio.play();
          this.playButton.textContent = '暫停';
          this.playbackState.textContent = '播放中';
        } catch (error) {
          this.playbackState.textContent = '無法播放音訊';
          this.playButton.textContent = '播放';
        }
        return;
      }

      this.audio.pause();
      this.playButton.textContent = '播放';
      this.playbackState.textContent = '已暫停';
    }

    jumpToPreviousSentence() {
      const targetTime = this.subtitleRenderer.timeline.getPreviousStart(this.audio.currentTime);
      this.seekAndMaybePlay(targetTime);
    }

    jumpToNextSentence() {
      const targetTime = this.subtitleRenderer.timeline.getNextStart(this.audio.currentTime);
      this.seekAndMaybePlay(targetTime);
    }

    restartPlayback() {
      this.seekAndMaybePlay(0);
    }

    toggleLoop() {
      this.loopEnabled = !this.loopEnabled;
      this.audio.loop = this.loopEnabled;
      this.loopButton.textContent = `循環：${this.loopEnabled ? '開' : '關'}`;
    }

    setFontSize(sizeKey) {
      if (!(sizeKey in FONT_SIZE_MAP)) {
        return;
      }

      this.fontSize = sizeKey;
      this.subtitleRenderer.setFontSize(sizeKey);

      document.querySelectorAll('[data-font-size]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.fontSize === sizeKey);
      });

      // Also update book list font size class so selection cards scale
      const bookList = document.getElementById('bookList');
      if (bookList) {
        bookList.classList.remove('font-small', 'font-medium', 'font-large');
        bookList.classList.add(`font-${sizeKey}`);
      }
    }

    setPlaybackSpeed(speed) {
      if (!SPEED_OPTIONS.includes(speed)) {
        return;
      }

      this.speed = speed;
      this.audio.playbackRate = speed;

      document.querySelectorAll('[data-speed]').forEach((button) => {
        button.classList.toggle('is-active', Number(button.dataset.speed) === speed);
      });
    }

    seekAndMaybePlay(targetTime) {
      if (!Number.isFinite(targetTime)) {
        return;
      }

      this.audio.currentTime = Math.max(0, targetTime);
      this.syncUI();

      if (!this.audio.paused) {
        return;
      }

      this.audio.play().catch(() => {
        this.playbackState.textContent = '無法播放音訊';
        this.playButton.textContent = '播放';
      });
      this.playButton.textContent = '暫停';
    }

    syncUI() {
      const currentTime = this.audio.currentTime || 0;
      const duration = this.audio.duration || 0;
      const isPlaying = !this.audio.paused;

      this.subtitleRenderer.updateByTime(currentTime);
      this.timeState.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
      this.playButton.textContent = isPlaying ? '暫停' : '播放';

      if (this.currentSutra) {
        this.playbackState.textContent = isPlaying ? '播放中' : this.audio.ended ? '播放結束' : '已載入';
      }
    }

    renderEmptyState() {
      this.playbackState.textContent = '沒有可用經書';
      this.subtitleContainer.innerHTML = '<p class="subtitle-placeholder">尚未建立經書資料</p>';
    }

    renderErrorState(message) {
      this.playbackState.textContent = message;
      this.subtitleContainer.innerHTML = `<p class="subtitle-placeholder">${message}</p>`;
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const app = new SutraPlayerApp();
    app.init();
  });
})();
