"use strict";

(() => {
  const types = new Set(["image/png", "image/jpeg", "image/webp"]);
  const maxBytes = 3 * 1024 * 1024;

  function appendImages(target, images, remove) {
    const gallery = document.createElement("div");
    gallery.className = "image-gallery";
    for (const [index, image] of images.entries()) {
      const card = document.createElement("figure");
      card.className = "image-card";
      const link = document.createElement("a");
      link.href = image.url || image.data_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open full-size screenshot";
      if (image.data_url) {
        // Browsers block top-level data: navigation; use a short-lived blob URL.
        link.addEventListener("click", (event) => {
          event.preventDefault();
          const [prefix, encoded] = image.data_url.split(",");
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: prefix.slice(5, -7) }));
          window.open(url, "_blank", "noopener,noreferrer");
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        });
      }
      const preview = document.createElement("img");
      preview.src = link.href;
      preview.alt = image.name;
      preview.loading = "lazy";
      link.append(preview);
      const caption = document.createElement("figcaption");
      const name = document.createElement("span");
      name.textContent = image.name;
      caption.append(name);
      if (remove) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Remove";
        button.setAttribute("aria-label", `Remove ${image.name}`);
        button.addEventListener("click", () => remove(index));
        caption.append(button);
      }
      card.append(link, caption);
      gallery.append(card);
    }
    target.append(gallery);
  }

  window.appendSolutionImages = appendImages;
  window.SolutionImages = class {
    constructor(input, list, pasteTarget, onChange, onError) {
      this.input = input;
      this.list = list;
      this.onChange = onChange;
      this.onError = onError;
      this.images = [];
      this.busy = false;
      this.disabled = false;
      this.generation = 0;
      input.addEventListener("change", () => {
        const files = [...input.files];
        input.value = "";
        this.add(files);
      });
      pasteTarget.addEventListener("paste", (event) => {
        const files = [...(event.clipboardData?.items || [])]
          .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
          .map((item) => item.getAsFile()).filter(Boolean);
        if (files.length) { event.preventDefault(); this.add(files); }
      });
    }

    get value() { return [...this.images]; }

    setDisabled(disabled) {
      this.disabled = disabled;
      this.input.disabled = disabled || this.busy;
      this.input.parentElement.classList.toggle("disabled", this.input.disabled);
      for (const button of this.list.querySelectorAll("button")) button.disabled = disabled || this.busy;
    }

    render() {
      this.list.replaceChildren();
      appendImages(this.list, this.images, (index) => {
        if (this.disabled || this.busy) return;
        this.images.splice(index, 1);
        this.render();
        this.onChange();
      });
      this.setDisabled(this.disabled);
    }

    clear() {
      this.generation += 1;
      this.images = [];
      this.render();
      this.onChange();
    }

    async add(files) {
      if (this.disabled || this.busy || !files.length) return;
      this.busy = true;
      const generation = this.generation;
      this.setDisabled(this.disabled);
      this.onChange();
      try {
        if (this.images.length + files.length > 4) throw new Error("Attach at most four screenshots per submission.");
        const added = [];
        for (const file of files) {
          if (!types.has(file.type)) throw new Error("Screenshots must be PNG, JPEG, or WebP images.");
          if (!file.size || file.size > maxBytes) throw new Error("Each screenshot must be at most 3 MiB.");
          const data_url = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Unable to read the screenshot. Try selecting it again."));
            reader.readAsDataURL(file);
          });
          const image = new Image();
          image.src = data_url;
          try { await image.decode(); } catch { throw new Error("The screenshot is not a readable image."); }
          if (image.naturalWidth * image.naturalHeight > 20000000) throw new Error("Each screenshot must be at most 20 megapixels.");
          added.push({ name: (file.name || "Screenshot").slice(0, 200), data_url });
        }
        if (this.generation !== generation) return;
        this.images.push(...added);
        this.render();
      } catch (error) { this.onError(error.message, true); }
      finally {
        this.busy = false;
        this.setDisabled(this.disabled);
        this.onChange();
      }
    }
  };
})();
