const enterEase = "cubic-bezier(0.22, 1, 0.36, 1)";
const exitEase = "cubic-bezier(0.4, 0, 1, 1)";

/** Owns the visible lifetime, including a close that interrupts an opening. */
export class SurfaceTransition {
  private animations: Animation[] = [];
  private revision = 0;

  constructor(
    private root: HTMLElement,
    private panel?: HTMLElement,
    private enterDuration = 300,
    private exitDuration = 200,
  ) {}

  show(reduced: boolean) {
    this.run(true, reduced);
  }

  hide(reduced: boolean, finished: () => void = () => {}) {
    this.run(false, reduced, finished);
  }

  finish() {
    this.animations.forEach((animation) => animation.finish());
  }

  dispose() {
    this.revision++;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
  }

  private run(show: boolean, reduced: boolean, finished?: () => void) {
    const revision = ++this.revision;
    const hidden = this.root.hidden;
    const opacity = hidden ? "0" : getComputedStyle(this.root).opacity;
    const transform = this.panel
      ? hidden
        ? "translateY(12px)"
        : getComputedStyle(this.panel).transform
      : undefined;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
    this.root.hidden = false;
    this.root.dataset.transition = show ? "opening" : "closing";
    let timer: number | undefined;
    const complete = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (revision !== this.revision) return;
      this.root.hidden = !show;
      this.root.dataset.transition = show ? "open" : "closed";
      this.animations.forEach((animation) => animation.cancel());
      this.animations = [];
      finished?.();
    };
    if (reduced || (!show && hidden)) {
      complete();
      return;
    }
    const duration = show ? this.enterDuration : this.exitDuration;
    const options: KeyframeAnimationOptions = {
      duration,
      easing: show ? enterEase : exitEase,
      fill: "both",
    };
    const fade = this.root.animate(
      [{ opacity }, { opacity: show ? 1 : 0 }],
      options,
    );
    this.animations.push(fade);
    if (this.panel) {
      this.animations.push(
        this.panel.animate(
          [
            { transform },
            { transform: show ? "translateY(0)" : "translateY(8px)" },
          ],
          options,
        ),
      );
    }
    /* ★ 收尾不能只靠动画的 finished：动画被 cancel、被下一次 run 抢占，
       或者窗口被遮挡 / 无头环境里动画时间轴停住时，finished 可能永远不落定，
       于是 finished 回调永远不执行 —— 调用方（弹窗）会把"正在收尾"这个状态
       一直握在手里，整机跟着按不动。这里按动画时长补一条兜底，
       complete 自身按 revision 判重，重复调用是安全的。 */
    timer = window.setTimeout(complete, duration + 160);
    void fade.finished.then(complete).catch(() => {});
  }
}

export class ContentTransition {
  private animation?: Animation;

  reveal(element: HTMLElement, reduced: boolean) {
    const opacity =
      this.animation?.playState === "running"
        ? getComputedStyle(element).opacity
        : "0.35";
    this.cancel();
    if (!reduced)
      this.animation = element.animate([{ opacity }, { opacity: 1 }], {
        duration: 150,
        easing: enterEase,
      });
  }

  cancel() {
    this.animation?.cancel();
    this.animation = undefined;
  }
}
