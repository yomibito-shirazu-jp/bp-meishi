import React, { useState, useRef } from 'react';
import { CardData, CompanyGroup, AppState, UploadStatus, ElementStyle } from './types';
import { extractCardData } from './services/gemini';
import CardPreview from './components/CardPreview';
import { Upload, Printer, ArrowLeft, Plus, Trash2, Save, Building2, User, Phone, Mail, MapPin, Globe, Briefcase, Eye, EyeOff, Type, Bold, AlignLeft, AlignCenter, AlignRight, Move } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

const INITIAL_DATA: CompanyGroup[] = [];

const App: React.FC = () => {
  const [view, setView] = useState<AppState>(AppState.DASHBOARD);
  const [companies, setCompanies] = useState<CompanyGroup[]>(INITIAL_DATA);
  const [currentCard, setCurrentCard] = useState<CardData | null>(null);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>({ isUploading: false, message: '' });
  
  // Editor State
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState<boolean>(true);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const upsertCompanyGroup = (newCard: CardData) => {
    setCompanies(prev => {
      const companyName = newCard.companyName || "Uncategorized";
      const existingGroupIndex = prev.findIndex(g => g.name === companyName);
      
      if (existingGroupIndex >= 0) {
        const newGroups = [...prev];
        const cardIndex = newGroups[existingGroupIndex].cards.findIndex(c => c.id === newCard.id);
        if (cardIndex >= 0) {
          newGroups[existingGroupIndex].cards[cardIndex] = newCard;
        } else {
          newGroups[existingGroupIndex].cards.push(newCard);
        }
        return newGroups;
      } else {
        return [...prev, { name: companyName, cards: [newCard] }];
      }
    });
  };

  const handleDeleteCard = (companyName: string, cardId: string) => {
    setCompanies(prev => prev.map(group => {
        if (group.name !== companyName) return group;
        return {
            ...group,
            cards: group.cards.filter(c => c.id !== cardId)
        };
    }).filter(group => group.cards.length > 0));
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadStatus({ isUploading: true, message: 'Reading file...' });

    try {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const result = e.target?.result as string;
            const base64Data = result.split(',')[1];
            const mimeType = file.type;

            setSourceImage(result);
            setUploadStatus({ isUploading: true, message: 'Analyzing layout & text...' });

            try {
                const extracted = await extractCardData(base64Data, mimeType);
                
                const newCard: CardData = {
                    id: crypto.randomUUID(),
                    // @ts-ignore
                    fullName: extracted.fullName || "",
                    // @ts-ignore
                    title: extracted.title || "",
                    // @ts-ignore
                    companyName: extracted.companyName || "",
                    // @ts-ignore
                    email: extracted.email || "",
                    // @ts-ignore
                    phone: extracted.phone || "",
                    // @ts-ignore
                    mobile: extracted.mobile || "",
                    // @ts-ignore
                    address: extracted.address || "",
                    // @ts-ignore
                    website: extracted.website || "",
                    // @ts-ignore
                    layout: extracted.layout || {},
                };

                setCurrentCard(newCard);
                setView(AppState.EDIT);
                setUploadStatus({ isUploading: false, message: '' });
            } catch (err) {
                console.error(err);
                setUploadStatus({ isUploading: false, message: 'Failed to analyze card.', error: 'Analysis failed.' });
            }
        };
        reader.readAsDataURL(file);
    } catch (error) {
        setUploadStatus({ isUploading: false, message: 'Error reading file', error: 'Upload failed' });
    }
  };

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !currentCard) return;

      const reader = new FileReader();
      reader.onload = (e) => {
          const result = e.target?.result as string;
          setCurrentCard({ ...currentCard, logoUrl: result });
      };
      reader.readAsDataURL(file);
  };

  const handleLayoutUpdate = (field: string, newStyle: Partial<ElementStyle>) => {
      if (!currentCard) return;
      setCurrentCard({
          ...currentCard,
          layout: {
              ...currentCard.layout,
              [field]: { ...currentCard.layout[field], ...newStyle }
          }
      });
  };

  const handleExportPDF = async () => {
    if (!previewRef.current || !currentCard) return;
    
    // Temporarily hide overlay for clean print
    const wasOverlayVisible = showOverlay;
    setShowOverlay(false);
    
    // Wait for render
    setTimeout(async () => {
        const canvas = await html2canvas(previewRef.current!, {
            scale: 4,
            useCORS: true,
            backgroundColor: "#ffffff"
        });
    
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [91, 55] });
    
        pdf.addImage(imgData, 'PNG', 0, 0, 91, 55);
        pdf.save(`${currentCard.companyName}_${currentCard.fullName}_trace.pdf`);
        
        setShowOverlay(wasOverlayVisible);
    }, 100);
  };

  const handleSaveCard = () => {
    if (currentCard) {
        upsertCompanyGroup(currentCard);
        setView(AppState.DASHBOARD);
        setSourceImage(null);
    }
  };

  const renderToolbar = () => {
      if (!selectedField || !currentCard) return (
          <div className="h-12 flex items-center justify-center text-gray-400 text-sm italic bg-gray-50 border-b border-gray-200">
              Select an element on the card to edit style
          </div>
      );

      const style = currentCard.layout[selectedField];

      const updateStyle = (changes: Partial<ElementStyle>) => handleLayoutUpdate(selectedField, changes);

      return (
          <div className="h-14 flex items-center px-4 gap-4 bg-white border-b border-gray-200 overflow-x-auto no-scrollbar">
              <div className="flex items-center gap-2 border-r border-gray-200 pr-4">
                  <span className="text-xs font-bold uppercase text-gray-500">{selectedField}</span>
              </div>
              
              <div className="flex items-center gap-2">
                  <button onClick={() => updateStyle({ fontSize: Math.max(6, style.fontSize - 1) })} className="p-1 hover:bg-gray-100 rounded text-sm font-bold border w-8 h-8">-</button>
                  <span className="text-sm w-8 text-center">{style.fontSize}</span>
                  <button onClick={() => updateStyle({ fontSize: style.fontSize + 1 })} className="p-1 hover:bg-gray-100 rounded text-sm font-bold border w-8 h-8">+</button>
              </div>

              <div className="w-px h-6 bg-gray-200"></div>

              <div className="flex items-center gap-1">
                  <button 
                    onClick={() => updateStyle({ fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold' })} 
                    className={`p-1.5 rounded ${style.fontWeight === 'bold' ? 'bg-gray-200 text-black' : 'hover:bg-gray-100 text-gray-600'}`}
                  >
                      <Bold size={16} />
                  </button>
                  <button 
                    onClick={() => updateStyle({ fontFamily: style.fontFamily === 'Noto Sans JP' ? 'Noto Serif JP' : 'Noto Sans JP' })} 
                    className="px-2 py-1 text-xs border rounded hover:bg-gray-50 w-24 truncate"
                  >
                      {style.fontFamily === 'Noto Sans JP' ? 'Gothic' : 'Mincho'}
                  </button>
              </div>

              <div className="w-px h-6 bg-gray-200"></div>

              <div className="flex items-center gap-1">
                 <button onClick={() => updateStyle({ textAlign: 'left' })} className={`p-1.5 rounded ${style.textAlign === 'left' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}><AlignLeft size={16}/></button>
                 <button onClick={() => updateStyle({ textAlign: 'center' })} className={`p-1.5 rounded ${style.textAlign === 'center' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}><AlignCenter size={16}/></button>
                 <button onClick={() => updateStyle({ textAlign: 'right' })} className={`p-1.5 rounded ${style.textAlign === 'right' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}><AlignRight size={16}/></button>
              </div>

              <div className="w-px h-6 bg-gray-200"></div>

              <input 
                type="color" 
                value={style.color} 
                onChange={(e) => updateStyle({ color: e.target.value })} 
                className="w-8 h-8 p-0 border-0 rounded cursor-pointer"
              />
          </div>
      );
  };

  const renderEditor = () => {
      if (!currentCard) return null;

      return (
        <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">
             {/* Top Bar */}
            <div className="bg-white border-b border-gray-200 px-4 py-3 flex justify-between items-center z-20 shadow-sm">
                <button 
                    onClick={() => setView(AppState.DASHBOARD)}
                    className="flex items-center gap-2 text-gray-600 hover:text-gray-900 text-sm font-medium"
                >
                    <ArrowLeft size={18} />
                    Back
                </button>
                <div className="flex items-center gap-4">
                    <button 
                        onClick={() => setShowOverlay(!showOverlay)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${showOverlay ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50'}`}
                    >
                        {showOverlay ? <Eye size={16}/> : <EyeOff size={16}/>}
                        <span>{showOverlay ? 'Hide Trace Guide' : 'Show Trace Guide'}</span>
                    </button>
                    <div className="h-4 w-px bg-gray-300"></div>
                    <button 
                        onClick={handleSaveCard}
                        className="flex items-center gap-2 text-gray-700 hover:text-gray-900 text-sm font-medium"
                    >
                        <Save size={18} />
                        Save
                    </button>
                    <button 
                        onClick={handleExportPDF}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg shadow-sm text-sm font-medium flex items-center gap-2"
                    >
                        <Printer size={16} />
                        Export Print PDF
                    </button>
                </div>
            </div>

            {/* Toolbar */}
            {renderToolbar()}

            {/* Main Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Panel: Fields */}
                <div className="w-80 bg-white border-r border-gray-200 overflow-y-auto z-10 hidden md:block">
                     <div className="p-4 space-y-4">
                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Content</h3>
                        <div className="space-y-3">
                            {Object.keys(currentCard.layout).map((key) => {
                                const field = key as keyof CardData;
                                if (typeof currentCard[field] !== 'string') return null;
                                return (
                                    <div key={key} className={`group ${selectedField === key ? 'ring-2 ring-blue-100 rounded' : ''}`}>
                                        <label 
                                            className="block text-xs font-medium text-gray-500 mb-1 cursor-pointer hover:text-blue-600 flex items-center gap-1"
                                            onClick={() => setSelectedField(key)}
                                        >
                                            {key} {selectedField === key && <Move size={10} className="ml-auto"/>}
                                        </label>
                                        <input 
                                            type="text" 
                                            value={currentCard[field] as string}
                                            onChange={(e) => setCurrentCard({ ...currentCard, [field]: e.target.value })}
                                            onFocus={() => setSelectedField(key)}
                                            className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                        
                        <div className="pt-4 border-t border-gray-100">
                             <label className="block text-xs font-medium text-gray-500 mb-2">Logo Image</label>
                             <button 
                                onClick={() => logoInputRef.current?.click()}
                                className="w-full py-2 border border-dashed border-gray-300 rounded text-xs text-gray-500 hover:bg-gray-50"
                             >
                                 {currentCard.logoUrl ? "Replace Logo" : "Upload Logo"}
                             </button>
                             <input type="file" ref={logoInputRef} onChange={handleLogoUpload} className="hidden" accept="image/*" />
                        </div>
                     </div>
                </div>

                {/* Canvas Area */}
                <div className="flex-1 bg-gray-100 flex items-center justify-center p-8 overflow-auto relative">
                     {/* Checkered Background */}
                     <div className="absolute inset-0 opacity-10 pointer-events-none" style={{
                          backgroundImage: 'conic-gradient(#ccc 25%, #fff 0 50%, #ccc 0 75%, #fff 0)',
                          backgroundSize: '20px 20px'
                      }}></div>

                     <div className="relative shadow-2xl">
                         <CardPreview 
                            ref={previewRef}
                            data={currentCard}
                            scale={1.2} // Slightly larger for editing
                            onLayoutChange={handleLayoutUpdate}
                            selectedField={selectedField}
                            onSelectField={setSelectedField}
                            overlayImage={sourceImage}
                            showOverlay={showOverlay}
                         />
                     </div>
                </div>
            </div>
        </div>
      );
  };

  // Keep Dashboard Render (Simplified)
  const renderDashboard = () => (
    <div className="max-w-5xl mx-auto p-8">
        <header className="flex justify-between items-end mb-10 border-b border-gray-200 pb-6">
            <div>
                <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">BizCard Tracer</h1>
                <p className="text-gray-500 mt-2">Professional Reproduction & Print Generator</p>
            </div>
            <button 
                onClick={() => fileInputRef.current?.click()}
                className="bg-black hover:bg-gray-800 text-white px-6 py-3 rounded-lg font-medium shadow-lg hover:shadow-xl transition-all flex items-center gap-2"
            >
                <Plus size={20} />
                <span>New Trace Project</span>
            </button>
        </header>
        
        <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileUpload} accept="image/*,application/pdf" />
        
        {uploadStatus.isUploading && (
             <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
                 <div className="text-center">
                     <div className="animate-spin w-12 h-12 border-4 border-black border-t-transparent rounded-full mx-auto mb-4"></div>
                     <p className="text-lg font-medium text-gray-800">{uploadStatus.message}</p>
                 </div>
             </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {companies.flatMap(g => g.cards).map(card => (
                <div key={card.id} className="bg-white group rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col">
                    <div className="h-32 bg-gray-50 flex items-center justify-center border-b border-gray-100 relative">
                        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#000_1px,transparent_1px)] [background-size:16px_16px]"></div>
                        <h3 className="font-serif text-2xl text-gray-300 font-bold">{card.companyName?.[0]}</h3>
                    </div>
                    <div className="p-5 flex-1 flex flex-col">
                        <h4 className="font-bold text-gray-900 text-lg">{card.fullName}</h4>
                        <p className="text-gray-500 text-sm mb-4">{card.companyName}</p>
                        
                        <div className="mt-auto flex gap-2">
                             <button 
                                onClick={() => { setCurrentCard(card); setSourceImage(null); setView(AppState.EDIT); }}
                                className="flex-1 bg-gray-900 text-white py-2 rounded-md text-sm font-medium hover:bg-black"
                             >
                                 Edit Design
                             </button>
                             <button className="p-2 text-red-500 hover:bg-red-50 rounded-md"><Trash2 size={18}/></button>
                        </div>
                    </div>
                </div>
            ))}
            {companies.length === 0 && (
                <div className="col-span-full py-20 text-center text-gray-400">
                    No cards created yet. Start a new project to trace a card.
                </div>
            )}
        </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
        {view === AppState.DASHBOARD && renderDashboard()}
        {view === AppState.EDIT && renderEditor()}
    </div>
  );
};

export default App;