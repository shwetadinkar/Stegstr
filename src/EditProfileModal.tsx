import { useRef, useState } from "react";
import { uploadMedia } from "./upload";

export interface EditProfileModalProps {
  onClose: () => void;
  onSave: () => void;
  editName: string;
  onEditNameChange: (value: string) => void;
  editAbout: string;
  onEditAboutChange: (value: string) => void;
  editPicture: string;
  onEditPictureChange: (value: string) => void;
  editBanner: string;
  onEditBannerChange: (value: string) => void;
  /** Signs the NIP-98 upload token. Uploads are rejected without it. */
  privKeyHex: string;
  /** Uploads leave the machine, so they must respect the network switch. */
  networkEnabled: boolean;
}

export function EditProfileModal({
  onClose,
  onSave,
  editName,
  onEditNameChange,
  editAbout,
  onEditAboutChange,
  editPicture,
  onEditPictureChange,
  editBanner,
  onEditBannerChange,
  privKeyHex,
  networkEnabled,
}: EditProfileModalProps) {
  const editPfpInputRef = useRef<HTMLInputElement>(null);
  const editCoverInputRef = useRef<HTMLInputElement>(null);

  const [uploadError, setUploadError] = useState("");

  /**
   * Shared by both pickers. These used to `catch (_) {}` -- so a failed upload
   * was indistinguishable from nothing happening, which is how the NIP-98
   * rejection stayed invisible: every upload had been failing silently.
   */
  const upload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    apply: (url: string) => void,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!networkEnabled) {
      setUploadError("Uploading a picture needs the network, and Network is off. The image would be publicly readable.");
      return;
    }
    setUploadError("");
    try {
      const url = await uploadMedia(file, privKeyHex);
      if (url) apply(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePfpUpload = (e: React.ChangeEvent<HTMLInputElement>) => upload(e, onEditPictureChange);
  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => upload(e, onEditBannerChange);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {uploadError && (
          <p className="error" style={{ fontSize: "0.82rem", margin: "0 0 0.5rem", lineHeight: 1.4 }}>
            {uploadError}
          </p>
        )}
        <h3>Edit profile</h3>
        <label>
          Name
          <input type="text" value={editName} onChange={(e) => onEditNameChange(e.target.value)} placeholder="Display name" className="wide" />
        </label>
        <label>
          About
          <textarea value={editAbout} onChange={(e) => onEditAboutChange(e.target.value)} placeholder="Bio" rows={3} className="wide" />
        </label>
        <label>
          Picture
          <div className="edit-media-row">
            <input type="url" value={editPicture} onChange={(e) => onEditPictureChange(e.target.value)} placeholder="https://… or upload" className="wide" />
            <input ref={editPfpInputRef} type="file" accept="image/*" className="hidden-input" onChange={handlePfpUpload} />
            <button type="button" className="btn-secondary" onClick={() => editPfpInputRef.current?.click()}>Choose file</button>
          </div>
        </label>
        <label>
          Cover / banner
          <div className="edit-media-row">
            <input type="url" value={editBanner} onChange={(e) => onEditBannerChange(e.target.value)} placeholder="https://… or upload" className="wide" />
            <input ref={editCoverInputRef} type="file" accept="image/*" className="hidden-input" onChange={handleCoverUpload} />
            <button type="button" className="btn-secondary" onClick={() => editCoverInputRef.current?.click()}>Choose file</button>
          </div>
        </label>
        <div className="row modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={onSave} className="btn-primary">Save</button>
        </div>
      </div>
    </div>
  );
}
