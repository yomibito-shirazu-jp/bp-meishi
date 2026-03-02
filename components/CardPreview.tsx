import React, { forwardRef, useState, useEffect } from 'react';
import { CardData, ElementStyle, CardField } from '../types';

interface CardPreviewProps {
  data: CardData;
  scale?: number;
  onLayoutChange?: (field: string, newStyle: Partial<ElementStyle>) => void;
  selectedField: string | null;
  onSelectField: (field: string | null) => void;
  overlayImage?: string | null; // The original scan to trace over
  showOverlay: boolean;
}

const CardPreview = forwardRef<HTMLDivElement, CardPreviewProps>(({ 
  data, 
  scale = 1, 
  onLayoutChange, 
  selectedField, 
  onSelectField,
  overlayImage,
  showOverlay
}, ref) => {
  const baseWidth = 455; // 91mm * 5
  const baseHeight = 275; // 55mm * 5

  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent, field: string, style: ElementStyle) => {
      e.stopPropagation();
      onSelectField(field);
      setDragging(field);
      setDragOffset({
          x: e.clientX - style.x * scale,
          y: e.clientY - style.y * scale
      });
  };

  useEffect(() => {
      const handleMouseMove = (e: MouseEvent) => {
          if (!dragging || !onLayoutChange) return;
          
          const container = (ref as React.RefObject<HTMLDivElement>).current;
          if (!container) return;

          const rect = container.getBoundingClientRect();
          
          // Calculate new X,Y relative to container, removing scale
          let newX = (e.clientX - rect.left) / scale;
          let newY = (e.clientY - rect.top) / scale;

          // Simple snap grid (5px)
          newX = Math.round(newX / 5) * 5;
          newY = Math.round(newY / 5) * 5;

          onLayoutChange(dragging, { x: newX, y: newY });
      };

      const handleMouseUp = () => {
          setDragging(null);
      };

      if (dragging) {
          window.addEventListener('mousemove', handleMouseMove);
          window.addEventListener('mouseup', handleMouseUp);
      }
      return () => {
          window.removeEventListener('mousemove', handleMouseMove);
          window.removeEventListener('mouseup', handleMouseUp);
      };
  }, [dragging, onLayoutChange, scale, ref]);

  const renderField = (field: string, value: string) => {
      if (!value) return null;
      const style = data.layout[field] || { x: 0, y: 0, fontSize: 12, color: '#000', fontFamily: 'Noto Sans JP' };
      const isSelected = selectedField === field;

      return (
          <div
              key={field}
              onMouseDown={(e) => handleMouseDown(e, field, style)}
              style={{
                  position: 'absolute',
                  left: `${style.x}px`,
                  top: `${style.y}px`,
                  fontSize: `${style.fontSize}px`,
                  fontFamily: style.fontFamily,
                  fontWeight: style.fontWeight,
                  color: style.color,
                  textAlign: style.textAlign,
                  whiteSpace: 'pre-wrap',
                  cursor: dragging === field ? 'grabbing' : 'grab',
                  border: isSelected ? '1px dashed #3b82f6' : '1px solid transparent',
                  padding: '2px 4px',
                  zIndex: 10,
                  userSelect: 'none',
              }}
              className="hover:border-blue-300 transition-colors"
          >
              {value}
          </div>
      );
  };

  const renderLogo = () => {
      if (!data.logoUrl) return null;
      // We assume logo is also draggable in a real app, but for now fixed or handled as a field?
      // Let's make logo separate in future, for now simplified.
      return (
          <img 
            src={data.logoUrl} 
            alt="logo" 
            className="absolute top-4 right-4 h-12 object-contain pointer-events-none" 
            style={{ zIndex: 5 }}
          />
      );
  };

  return (
    <div 
        ref={ref}
        onClick={() => onSelectField(null)}
        style={{
            width: `${baseWidth}px`,
            height: `${baseHeight}px`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            backgroundColor: '#ffffff',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
        }}
    >
        {/* Trace Overlay */}
        {showOverlay && overlayImage && (
            <div 
                className="absolute inset-0 pointer-events-none z-0"
                style={{ 
                    backgroundImage: `url(${overlayImage})`,
                    backgroundSize: 'contain',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                    opacity: 0.4
                }}
            />
        )}

        {renderField('companyName', data.companyName)}
        {renderField('title', data.title)}
        {renderField('fullName', data.fullName)}
        {renderField('email', data.email)}
        {renderField('phone', data.phone)}
        {renderField('mobile', data.mobile)}
        {renderField('address', data.address)}
        {renderField('website', data.website)}
        {renderLogo()}
    </div>
  );
});

CardPreview.displayName = 'CardPreview';

export default CardPreview;