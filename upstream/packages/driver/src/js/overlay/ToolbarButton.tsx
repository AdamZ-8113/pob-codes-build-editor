import type React from "react";

interface ToolbarButtonProps {
  icon: React.ReactNode;
  tooltip: string;
  onClick: () => void;
  isActive?: boolean;
  ariaHaspopup?: "menu";
  ariaExpanded?: boolean;
}

export const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  icon,
  tooltip,
  onClick,
  isActive = false,
  ariaHaspopup,
  ariaExpanded,
}) => {
  const baseClasses = "pw:btn pw:btn-square";
  const variantClasses = isActive ? "pw:btn-primary" : "pw:btn-ghost";

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={isActive}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
      className={`${baseClasses} ${variantClasses}`}
      onClick={onClick}
    >
      {icon}
    </button>
  );
};
